"""Stateful Silero V6 ONNX scoring and independent streaming speech gates."""

from dataclasses import dataclass
import importlib.util
from pathlib import Path

import numpy as np

RATE = 16000
WINDOW = 512


class SileroScorer:
    def __init__(self):
        import onnxruntime as ort
        spec = importlib.util.find_spec("faster_whisper")
        path = Path(spec.origin).parent / "assets" / "silero_vad_v6.onnx"
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.log_severity_level = 4
        self.session = ort.InferenceSession(str(path), sess_options=options,
                                            providers=["CPUExecutionProvider"])
        if {item.name for item in self.session.get_inputs()} != {"input", "h", "c"}:
            raise RuntimeError("Unsupported bundled Silero model interface")
        self.reset()

    def reset(self):
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros_like(self.h)
        self.context = np.zeros(64, dtype=np.float32)

    def __call__(self, samples):
        samples = np.asarray(samples, dtype=np.float32)
        if samples.shape != (WINDOW,) or not np.isfinite(samples).all():
            raise ValueError("Silero requires 512 finite mono samples")
        audio = np.concatenate((self.context, samples))[None, :]
        output, self.h, self.c = self.session.run(None, {"input": audio, "h": self.h, "c": self.c})
        self.context = samples[-64:].copy()
        probability = float(np.asarray(output).reshape(-1)[0])
        if not np.isfinite(probability) or not 0 <= probability <= 1:
            raise RuntimeError("Invalid Silero probability")
        return probability


@dataclass(frozen=True)
class VadSettings:
    threshold: float = 0.5
    release: float = 0.35
    min_speech_samples: int = 1536
    silence_samples: int = 6400
    pre_samples: int = 3200
    tail_samples: int = 1600

    def __post_init__(self):
        if not 0 < self.release <= self.threshold < 1:
            raise ValueError("Invalid VAD thresholds")
        if not all(isinstance(v, int) and v >= 0 for v in
                   (self.min_speech_samples, self.silence_samples, self.pre_samples, self.tail_samples)):
            raise ValueError("Invalid VAD durations")
        if self.min_speech_samples < WINDOW or self.silence_samples < WINDOW:
            raise ValueError("VAD speech/silence durations must span a window")


@dataclass(frozen=True)
class VadEvent:
    kind: str
    sample: int


class VadGate:
    def __init__(self, scorer, settings=None):
        self.scorer = scorer
        self.settings = settings or VadSettings()
        self.reset(0)

    def reset(self, start_sample=0):
        self.scorer.reset()
        self.pending = np.empty(0, dtype=np.float32)
        self.cursor = self.anchor = start_sample
        self.active = False
        self.attack = self.quiet = None

    def feed(self, samples):
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError("VAD requires finite mono audio")
        audio = np.concatenate((self.pending, samples))
        events = []
        complete = len(audio) // WINDOW * WINDOW
        for offset in range(0, complete, WINDOW):
            probability = self.scorer(audio[offset:offset + WINDOW])
            start = self.cursor
            self.cursor += WINDOW
            if not self.active:
                if probability >= self.settings.threshold:
                    if self.attack is None:
                        self.attack = start
                    if self.cursor - self.attack >= self.settings.min_speech_samples:
                        self.active = True
                        events.append(VadEvent("start", max(self.anchor, self.attack - self.settings.pre_samples)))
                else:
                    self.attack = None
            elif probability < self.settings.release:
                if self.quiet is None:
                    self.quiet = start
                if self.cursor - self.quiet >= self.settings.silence_samples:
                    events.append(VadEvent("end", min(self.cursor, self.quiet + self.settings.tail_samples)))
                    self.active = False
                    self.attack = self.quiet = None
            else:
                self.quiet = None
        self.pending = audio[complete:].copy()
        return events

    def flush(self):
        # Process a very short trailing block, but never count its synthetic padding.
        real_end = self.cursor + len(self.pending)
        events = self.feed(np.zeros(WINDOW - len(self.pending), dtype=np.float32)) if len(self.pending) else []
        events = [VadEvent(e.kind, min(e.sample, real_end)) for e in events]
        if self.active:
            events.append(VadEvent("end", real_end))
        self.reset(real_end)
        return events
