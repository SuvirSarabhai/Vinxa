"""Reusable faster-whisper WAV engine. This module does not capture audio."""

from dataclasses import dataclass
import importlib
import os
from pathlib import Path
import shutil
from threading import Lock
from time import perf_counter

monotonic = perf_counter

from .audio_utils import read_wav, real_time_factor
from .local_agreement import Word, normalized


class SpeechEngineError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Segment:
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Transcription:
    text: str
    segments: list[Segment]
    language: str
    language_probability: float | None
    audio_duration_seconds: float
    model_load_seconds: float
    inference_seconds: float
    rtf: float


@dataclass(frozen=True)
class WordInference:
    words: tuple[Word, ...]
    inference_seconds: float
    segments_seen: int = 0
    segments_filtered: int = 0
    words_outside_window: int = 0
    started_monotonic_seconds: float = 0
    completed_monotonic_seconds: float = 0


def model_cache(path: str | Path | None = None) -> Path:
    configured = path or os.environ.get("VINXA_MODEL_DIR")
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache"))
    target = Path(configured) if configured else base / "Vinxa" / "models"
    target = target.expanduser().resolve()
    repository = Path(__file__).resolve().parents[1]
    if target == repository or repository in target.parents:
        raise SpeechEngineError("INVALID_CACHE", "Model cache must be outside the repository")
    return target


class SpeechEngine:
    def __init__(self, model: str = "base.en", *, device: str = "cpu", compute_type: str = "int8",
                 cache_dir: str | Path | None = None, cpu_threads: int = 4,
                 local_files_only: bool = False, model_path: str | Path | None = None):
        if model not in ("base.en", "small", "tiny.en"):
            raise ValueError("Supported models are base.en, small and optional tiny.en")
        if cpu_threads < 1:
            raise ValueError("CPU thread count must be positive")
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.cache_dir = model_cache(cache_dir)
        self.cpu_threads = cpu_threads
        self.local_files_only = local_files_only
        self.model_path = Path(model_path).expanduser() if model_path else None
        self.model_load_seconds = 0.0
        self._model = None
        self._lock = Lock()

    def load(self) -> None:
        with self._lock:
            self._load()

    def _load(self) -> None:
        if self._model is not None:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise SpeechEngineError("CACHE_UNAVAILABLE", "Cannot create or access the model cache") from error
        if self.model_path is not None:
            if not self.model_path.is_dir() or not (self.model_path / "model.bin").is_file():
                raise SpeechEngineError("MODEL_MISSING", "Local model directory or model.bin is missing")
            identifier = str(self.model_path)
        else:
            identifier = self.model_name
            cached = self.cache_dir / f"models--Systran--faster-whisper-{self.model_name}" / "snapshots"
            if not self.local_files_only and not cached.exists():
                estimated_bytes = {"tiny.en": 100, "base.en": 200, "small": 600}[self.model_name] * 1024 * 1024
                try:
                    free_space = shutil.disk_usage(self.cache_dir).free
                except OSError as error:
                    raise SpeechEngineError("CACHE_UNAVAILABLE", "Cannot check free space on model cache disk") from error
                if free_space < estimated_bytes:
                    raise SpeechEngineError("DISK_SPACE", "Insufficient free space for the first model download")
        started = perf_counter()
        try:
            whisper = importlib.import_module("faster_whisper")
            self._model = whisper.WhisperModel(identifier, device=self.device, compute_type=self.compute_type,
                                             cpu_threads=self.cpu_threads, download_root=str(self.cache_dir),
                                             local_files_only=self.local_files_only)
        except ImportError as error:
            raise SpeechEngineError("DEPENDENCY_MISSING", "Install the Phase 1 Python dependencies") from error
        except Exception as error:
            code = "MODEL_UNAVAILABLE" if self.local_files_only else "MODEL_LOAD_FAILED"
            raise SpeechEngineError(code, "Model could not load; check cache integrity, connectivity, disk space and runtime libraries") from error
        self.model_load_seconds = perf_counter() - started

    def transcribe(self, wav_path: str | Path, *, language: str | None = None, beam_size: int = 5) -> Transcription:
        audio = read_wav(wav_path)
        if beam_size < 1:
            raise ValueError("Beam size must be positive")
        with self._lock:
            self._load()
            started = perf_counter()
            try:
                iterator, info = self._model.transcribe(audio.samples, language=language, beam_size=beam_size,
                                                       vad_filter=False, condition_on_previous_text=False)
                segments = [Segment(segment.text.strip(), round(segment.start * 1000), round(segment.end * 1000))
                            for segment in iterator]
            except Exception as error:
                raise SpeechEngineError("INFERENCE_FAILED", "Local transcription failed") from error
            elapsed = perf_counter() - started
        lang_prob = float(info.language_probability) if getattr(info, "language_probability", None) is not None else None
        return Transcription(" ".join(segment.text for segment in segments), segments, getattr(info, "language", language or "en"),
                             lang_prob, audio.duration_seconds, self.model_load_seconds,
                             elapsed, real_time_factor(elapsed, audio.duration_seconds))

    def transcribe_samples(self, samples, *, language="en", beam_size=1, offset=0) -> WordInference:
        """Bounded in-memory inference; the existing WAV API remains unchanged."""
        import logging
        import numpy as np
        audio = np.asarray(samples, dtype=np.float32)
        if audio.ndim != 1 or not 0 < len(audio) <= 480000 or not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1:
            raise SpeechEngineError("INVALID_AUDIO", "Expected bounded finite 16 kHz mono samples")
        if not isinstance(offset, int) or offset < 0 or not 1 <= beam_size <= 5:
            raise SpeechEngineError("INVALID_AUDIO", "Invalid inference options")
        library_logger = logging.getLogger("faster_whisper")
        library_logger.setLevel(logging.ERROR)
        library_logger.propagate = False
        with self._lock:
            self._load()
            started = perf_counter()
            started_monotonic = monotonic()
            try:
                segments, _ = self._model.transcribe(
                    audio, language=language, beam_size=beam_size, word_timestamps=True,
                    condition_on_previous_text=False, vad_filter=False, temperature=0.0,
                    no_speech_threshold=0.6, log_prob_threshold=-1.0, compression_ratio_threshold=2.4,
                    hallucination_silence_threshold=1.0)
                words = []
                quiet = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))) < 0.003
                segments_seen = segments_filtered = words_outside_window = 0
                for segment in segments:
                    segments_seen += 1
                    if (getattr(segment, "avg_logprob", 0) < -1.0 or
                            (getattr(segment, "no_speech_prob", 0) >= 0.6 and getattr(segment, "avg_logprob", 0) < -0.5) or
                            getattr(segment, "compression_ratio", 1) > 2.4):
                        segments_filtered += 1
                        continue
                    if quiet and normalized(segment.text) in {"thankyouforwatching", "thanksforwatching", "subscribe"}:
                        segments_filtered += 1
                        continue
                    for word in segment.words or []:
                        start, end = round(word.start * 16000), round(word.end * 16000)
                        if 0 <= start < end <= len(audio) and word.word.strip():
                            words.append(Word(word.word, offset + start, offset + end))
                        else:
                            words_outside_window += 1
            except Exception as error:
                raise SpeechEngineError("INFERENCE_FAILED", "Local word inference failed") from error
            return WordInference(tuple(words), perf_counter() - started, segments_seen, segments_filtered, words_outside_window,
                                 started_monotonic, monotonic())

    def warmup(self, *, language="en"):
        import numpy as np
        self.load()
        # Only execute synthetic inference; never publish or save its hypothesis.
        self.transcribe_samples(np.zeros(8000, dtype=np.float32), language=language)
