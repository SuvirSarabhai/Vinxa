"""Per-source streaming, bounded windows and a single shared model worker."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial
import os
from time import monotonic

import numpy as np

from .audio_buffer import AudioBuffer
from .engine import SpeechEngine
from .local_agreement import LocalAgreement
from .protocol import ProtocolError
from .scheduling import FairQueue
from .vad import SileroScorer, VadGate, VadSettings


@dataclass(frozen=True)
class StreamingSettings:
    interval: float = 1.0
    window_seconds: float = 6.0
    buffer_seconds: float = 20.0
    overlap_seconds: float = 0.3
    queue_per_source: int = 2
    beam_size: int = 1
    cpu_threads: int = 4
    vad: VadSettings = field(default_factory=VadSettings)

    def __post_init__(self):
        if not 0.25 <= self.interval <= 3 or not 2 <= self.window_seconds <= 20:
            raise ValueError("Invalid streaming interval/window")
        if not self.window_seconds <= self.buffer_seconds <= 30 or not 0 <= self.overlap_seconds <= 1:
            raise ValueError("Invalid streaming buffer/overlap")
        if not 1 <= self.queue_per_source <= 8 or not 1 <= self.beam_size <= 5 or not 1 <= self.cpu_threads <= 16:
            raise ValueError("Invalid streaming worker settings")

    @classmethod
    def environment(cls):
        return cls(interval=float(os.environ.get("VINXA_STREAM_INTERVAL_SECONDS", "1")),
                   window_seconds=float(os.environ.get("VINXA_STREAM_WINDOW_SECONDS", "6")),
                   buffer_seconds=float(os.environ.get("VINXA_MAX_BUFFER_SECONDS", "20")),
                   overlap_seconds=float(os.environ.get("VINXA_STREAM_OVERLAP_SECONDS", "0.3")),
                   queue_per_source=int(os.environ.get("VINXA_MAX_QUEUE_PER_SOURCE", "2")),
                   beam_size=int(os.environ.get("VINXA_BEAM_SIZE", "1")),
                   cpu_threads=int(os.environ.get("VINXA_CPU_THREADS", "4")),
                   vad=VadSettings(threshold=float(os.environ.get("VINXA_VAD_THRESHOLD", "0.5")),
                                   release=float(os.environ.get("VINXA_VAD_RELEASE", "0.35"))))


@dataclass
class Utterance:
    source: str
    number: int
    epoch: int
    start: int
    agreement: LocalAgreement
    chunk: int = 0
    provisional: bool = False
    last_pass_sample: int = 0
    lost_through: int = 0


@dataclass
class Job:
    utterance: Utterance
    samples: np.ndarray
    start: int
    end: int
    final: bool
    created: float = field(default_factory=monotonic)

    @property
    def source(self):
        return self.utterance.source

    @property
    def key(self):
        return self.source, self.utterance.number


class SourceState:
    def __init__(self, source, settings, scorer):
        self.source = source
        self.buffer = AudioBuffer(round(settings.buffer_seconds * 16000))
        self.vad = VadGate(scorer, settings.vad)
        self.epoch = self.number = self.expected = 0
        self.final_through = 0
        self.anchored = self.ended = False
        self.held = self.current = None


class StreamingPipeline:
    def __init__(self, config, emit, *, settings=None, engine=None, scorer_factory=SileroScorer):
        self.config, self.emit = config, emit
        self.settings = settings or StreamingSettings.environment()
        self.engine = engine or SpeechEngine(config["model"], cpu_threads=self.settings.cpu_threads, local_files_only=True)
        self.scorer_factory = scorer_factory
        self.sources = {}
        self.queue = FairQueue(config["enabledSources"], self.settings.queue_per_source)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vinxa-inference")
        self.worker = None
        self.ready = self.paused = self.closed = self.failed = self.busy = False
        self.idle = asyncio.Event()
        self.idle.set()

    async def _emit(self, event):
        await self.emit({**event, "sessionId": self.config["sessionId"], "generation": self.config["generation"]})

    async def status(self, status, **extra):
        await self._emit({"type": "status", "status": status, **extra})

    async def error(self, code, message, recoverable=True):
        await self._emit({"type": "error", "code": code, "message": message, "recoverable": recoverable})

    async def start(self):
        loop = asyncio.get_running_loop()
        failure_code = "MODEL_LOAD_FAILED"
        try:
            await self.status("loading")
            await loop.run_in_executor(self.executor, self.engine.load)
            if self.closed:
                return
            failure_code = "WARMUP_FAILED"
            await self.status("warming-up")
            await loop.run_in_executor(self.executor, partial(self.engine.warmup, language=self.config["language"]))
            scorers = await loop.run_in_executor(self.executor, lambda: {s: self.scorer_factory() for s in self.config["enabledSources"]})
            if self.closed:
                return
            self.sources = {s: SourceState(s, self.settings, scorer) for s, scorer in scorers.items()}
            self.ready = True
            self.worker = asyncio.create_task(self._run())
            await self.status("ready")
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            await self.error(failure_code, "Local model or VAD initialization failed", False)
            await self.status("error")

    async def _require(self, source=None):
        if not self.ready or self.failed or self.closed:
            raise ProtocolError("NOT_READY", "Transcription engine is unavailable", True)
        if source is not None and source not in self.sources:
            raise ProtocolError("SOURCE_DISABLED", "Audio source is disabled")

    async def anchor(self, source, sample, dropped=0):
        await self._require(source)
        state = self.sources[source]
        if sample < state.expected:
            raise ProtocolError("INVALID_CONTROL", "Source timeline cannot move backward")
        await self._clear_source(state, sample)
        state.anchored, state.ended = True, False
        if dropped:
            await self.error("AUDIO_DROPPED", "Audio discontinuity reported by capture")
            await self.status("listening", metrics={"source": source, "queueDepth": self.queue.depth, "droppedSamples": dropped})

    async def _clear_source(self, state, sample):
        state.epoch += 1
        if state.current and state.current.provisional:
            await self._text(state.current, [], True)
        state.current = state.held = None
        state.buffer.reset(sample)
        state.vad.reset(sample)
        state.expected = sample
        state.final_through = max(state.final_through, sample)
        state.anchored = False
        self.queue.clear(state.source)
        if not self.busy and not self.queue.depth:
            self.idle.set()

    async def ingest(self, frame):
        await self._require(frame.source)
        state = self.sources[frame.source]
        if self.paused or not state.anchored or state.ended:
            raise ProtocolError("NOT_READY", "Source must be active and anchored before audio", True)
        if state.held is not None:
            await self._process(state, state.held)
        state.held = np.frombuffer(frame.pcm, dtype="<i2").astype(np.float32) / 32768
        state.expected += len(state.held)

    async def _process(self, state, samples):
        dropped = state.buffer.append(samples)
        if dropped and state.current and state.current.agreement.committed_through < state.buffer.start:
            await self.error("AUDIO_DROPPED", "Uncommitted audio exceeded the bounded buffer")
            await self.status("processing", metrics={"source": state.source, "queueDepth": self.queue.depth, "droppedSamples": dropped})
        events = state.vad.feed(samples)
        await self._vad_events(state, events)
        if state.current and state.buffer.end - state.current.last_pass_sample >= self.settings.interval * 16000:
            await self._schedule(state, False, state.buffer.end)

    async def _vad_events(self, state, events):
        for event in events:
            if event.kind == "start":
                state.number += 1
                start = max(event.sample, state.buffer.start, state.final_through)
                state.current = Utterance(state.source, state.number, state.epoch, start,
                                          LocalAgreement(start), last_pass_sample=start)
            elif state.current:
                await self._schedule(state, True, min(event.sample, state.buffer.end))
                state.current = None

    async def _schedule(self, state, final, end):
        utterance = state.current
        if utterance is None:
            return
        start = max(utterance.start, utterance.agreement.committed_through - round(self.settings.overlap_seconds * 16000),
                    end - round(self.settings.window_seconds * 16000))
        samples, start = state.buffer.snapshot(start, end)
        if not len(samples):
            return
        lost = max(0, start - max(utterance.agreement.committed_through, utterance.lost_through))
        if lost:
            utterance.lost_through = start
            await self.error("AUDIO_DROPPED", "Uncommitted audio moved outside the rolling window")
            await self.status("processing", metrics={"source": state.source, "queueDepth": self.queue.depth, "droppedSamples": lost})
        if self.queue.put(Job(utterance, samples, start, end, final)):
            utterance.last_pass_sample = end
            self.idle.clear()
        else:
            await self.error("AUDIO_DROPPED", "Inference finalization queue reached its limit")
            await self.status("processing", metrics={"source": state.source, "queueDepth": self.queue.depth, "droppedSamples": len(samples)})

    async def _text(self, utterance, words, final):
        if not words and not utterance.provisional:
            return
        text = "".join(word.text if word.text.startswith(" ") else " " + word.text for word in words).strip()
        await self._emit({"type": "final" if final else "partial", "source": utterance.source,
                          "id": f"{self.config['generation']}:{utterance.source}:{utterance.number}:{utterance.chunk}",
                          "text": text, "startMs": round((words[0].start if words else utterance.start) / 16),
                          "endMs": round((words[-1].end if words else utterance.start) / 16)})
        utterance.provisional = not final
        if final:
            utterance.chunk += 1

    async def _run(self):
        loop = asyncio.get_running_loop()
        try:
            while not self.closed:
                job = await self.queue.get()
                if job is None:
                    break
                self.busy = True
                wait_ms = (monotonic() - job.created) * 1000
                await self.status("processing")
                result = await loop.run_in_executor(self.executor, partial(
                    self.engine.transcribe_samples, job.samples, language=self.config["language"],
                    beam_size=self.settings.beam_size, offset=job.start))
                state, utterance = self.sources[job.source], job.utterance
                if not self.closed and not self.paused and utterance.epoch == state.epoch:
                    words = [word for word in result.words if word.start >= state.final_through]
                    if job.final:
                        final = utterance.agreement.finish(words)
                        await self._text(utterance, final, True)
                    else:
                        stable, pending = utterance.agreement.update(words)
                        if stable:
                            await self._text(utterance, stable, True)
                        await self._text(utterance, pending, False)
                    state.final_through = max(state.final_through, utterance.agreement.committed_through)
                    trim = max(state.buffer.start, utterance.agreement.committed_through - round(self.settings.overlap_seconds * 16000))
                    state.buffer.trim(trim)
                    await self.status("listening", metrics={"source": job.source,
                        "inferenceMs": result.inference_seconds * 1000, "queueWaitMs": wait_ms,
                        "queueDepth": self.queue.depth, "droppedSamples": 0})
                self.busy = False
                if not self.queue.depth:
                    self.idle.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            self.ready = False
            self.queue.clear()
            self.busy = False
            self.idle.set()
            await self.error("INFERENCE_FAILED", "Local inference worker failed", False)
            await self.status("error")

    async def source_end(self, source, padding=0):
        await self._require(source)
        state = self.sources[source]
        if state.ended:
            raise ProtocolError("INVALID_CONTROL", "Source already ended")
        if state.held is None and padding:
            raise ProtocolError("INVALID_CONTROL", "Padding requires a final audio frame")
        if state.held is not None:
            await self._process(state, state.held[:1600 - padding])
            state.expected -= padding
            state.held = None
        await self._vad_events(state, state.vad.flush())
        if state.current:
            await self._schedule(state, True, state.buffer.end)
            state.current = None
        state.ended = True

    async def pause(self):
        await self._require()
        self.paused = True
        for state in self.sources.values():
            await self._clear_source(state, state.expected)

    async def resume(self):
        await self._require()
        self.paused = False  # sources require new measured anchors

    async def stop(self):
        if self.ready and not self.failed and not self.paused:
            for source, state in self.sources.items():
                if not state.ended:
                    await self.source_end(source)
            await asyncio.wait_for(self.idle.wait(), 30)
        await self.close()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        self.ready = False
        self.queue.close()
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        for state in self.sources.values():
            state.buffer.reset(state.expected)
            state.current = state.held = None
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=True)
