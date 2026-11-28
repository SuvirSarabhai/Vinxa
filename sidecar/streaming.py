"""Per-source streaming, bounded windows and a single shared model worker."""

import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import partial
import os
from time import perf_counter as monotonic

import numpy as np

from .audio_buffer import AudioBuffer
from .diagnostics import Diagnostics
from .dedup import EchoDeduplicator
from .engine import SpeechEngine
from .local_agreement import LocalAgreement
from .protocol import ProtocolError
from .sample_accounting import SampleAccounting
from .scheduling import FairQueue
from .vad import SileroScorer, VadGate, VadSettings


@dataclass(frozen=True)
class StreamingSettings:
    interval: float = 1.0
    window_seconds: float = 6.0
    buffer_seconds: float = 20.0
    overlap_seconds: float = 0.3
    queue_per_source: int = 2
    input_frames_per_source: int = 32
    event_queue_size: int = 256
    beam_size: int = 1
    cpu_threads: int = 4
    vad: VadSettings = field(default_factory=VadSettings)

    def __post_init__(self):
        if not 0.25 <= self.interval <= 3 or not 2 <= self.window_seconds <= 20:
            raise ValueError("Invalid streaming interval/window")
        if not self.window_seconds <= self.buffer_seconds <= 30 or not 0 <= self.overlap_seconds <= 1:
            raise ValueError("Invalid streaming buffer/overlap")
        if not all(isinstance(value, int) and not isinstance(value, bool) for value in
                   (self.queue_per_source, self.input_frames_per_source, self.event_queue_size, self.beam_size, self.cpu_threads)) or not 1 <= self.queue_per_source <= 8 or not 1 <= self.beam_size <= 5 or not 1 <= self.cpu_threads <= 16:
            raise ValueError("Invalid streaming worker settings")
        if not 1 <= self.input_frames_per_source <= 64 or not 4 <= self.event_queue_size <= 512:
            raise ValueError("Invalid handoff queue bounds")

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
    provisional_start: int = 0
    provisional_end: int = 0
    last_pass_sample: int = 0
    live_passes: int = 0
    ended_at_ms: float | None = None


@dataclass
class Job:
    utterance: Utterance
    samples: np.ndarray
    start: int
    end: int
    final: bool
    created: float = field(default_factory=monotonic)
    timing: dict = field(default_factory=dict)
    frames: tuple = ()

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
        self.lost_through = 0
        self.anchored = self.ended = self.ending = False
        self.cursor = 0
        self.inbox = asyncio.Queue(maxsize=settings.input_frames_per_source)
        self.consumer = None
        self.working = False
        self.active_input_samples = self.processing_samples = self.queued_samples = 0
        self.accounting = SampleAccounting()
        self.unreported_drops = 0
        self.held = self.current = None
        self.frame_history = deque(maxlen=400)
        self.next_sequence = None


class StreamingPipeline:
    def __init__(self, config, emit, *, settings=None, engine=None, scorer_factory=SileroScorer, prewarmed=False):
        self.config, self.emit = config, emit
        self.prewarmed = prewarmed
        self.settings = settings or StreamingSettings.environment()
        self.engine = engine or SpeechEngine(config["model"], cpu_threads=self.settings.cpu_threads, local_files_only=True,
                                            model_path=os.environ.get("VINXA_SPEECH_MODEL_PATH") or None)
        self.scorer_factory = scorer_factory
        self.diagnostics = Diagnostics()
        self.dedup = EchoDeduplicator()
        self.last_dequeued = {}
        self.sources = {}
        self.queue = FairQueue(config["enabledSources"], self.settings.queue_per_source)
        self.queue.observe = self._observe_queue
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vinxa-inference")
        self.worker = None
        self.current_job = None
        self.vad_executor = ThreadPoolExecutor(max_workers=len(config["enabledSources"]), thread_name_prefix="vinxa-vad")
        self.outbox = asyncio.Queue(maxsize=self.settings.event_queue_size)
        self.sender = None
        self.close_task = None
        self.sending = self.emission_failed = False
        self.ready = self.paused = self.closed = self.failed = self.busy = False
        self.idle = asyncio.Event()
        self.idle.set()

    def _observe_queue(self, stage, job):
        self.diagnostics.record(stage, job.source, len(job.samples), start=job.start, end=job.end,
                                utterance=job.utterance.number, final=job.final,
                                age_ms=(monotonic() - job.created) * 1000, queue_depth=self.queue.depth)

    def _discard_events(self, reason):
        while not self.outbox.empty():
            event, _ = self.outbox.get_nowait()
            if "source" in event:
                self.diagnostics.record(reason, event["source"])
            self.outbox.task_done()

    def _refresh_idle(self):
        if (not self.busy and not self.queue.depth and not self.sending and self.outbox.empty()
                and all(not state.working and state.inbox.empty() for state in self.sources.values())):
            self.idle.set()
        else:
            self.idle.clear()

    async def _send_events(self):
        while True:
            event, trace = await self.outbox.get()
            self.sending = True
            try:
                if (event["type"] == "partial" and trace and
                        trace["epoch"] != self.sources[event["source"]].epoch):
                    self.diagnostics.record("event_discarded_invalidated", event["source"])
                    continue
                if "timing" in event:
                    event["timing"]["emittedMs"] = monotonic() * 1000
                await self.emit(event)
                if trace:
                    self.diagnostics.record("text_emitted", event["source"], **trace)
            except asyncio.CancelledError:
                if "source" in event:
                    self.diagnostics.record("event_delivery_interrupted", event["source"])
                raise
            except Exception:
                self.failed = self.emission_failed = True
                self.ready = False
                if "source" in event:
                    self.diagnostics.record("event_delivery_failed", event["source"])
                return
            finally:
                self.outbox.task_done()
                if self.emission_failed:
                    self._discard_events('event_discarded_transport_failure')
                self.sending = False
                self._refresh_idle()

    async def _emit(self, event, trace=None):
        if self.emission_failed:
            raise ProtocolError("EMISSION_FAILED", "Local event delivery failed", False)
        payload = {**event, "sessionId": self.config["sessionId"], "generation": self.config["generation"]}
        await self.outbox.put((payload, trace))
        if self.emission_failed:
            self._discard_events("event_discarded_transport_failure")
            raise ProtocolError("EMISSION_FAILED", "Local event delivery failed", False)
        self.idle.clear()
        await asyncio.sleep(0)

    async def _flush_events(self):
        if not self.emission_failed:
            await asyncio.wait_for(self.outbox.join(), 5)

    async def status(self, status, **extra):
        await self._emit({"type": "status", "status": status, **extra})

    async def error(self, code, message, recoverable=True):
        await self._emit({"type": "error", "code": code, "message": message, "recoverable": recoverable})

    async def start(self):
        loop = asyncio.get_running_loop()
        self.sender = asyncio.create_task(self._send_events())
        failure_code = "MODEL_LOAD_FAILED"
        try:
            if not self.prewarmed:
                await self.status("loading")
                await loop.run_in_executor(self.executor, self.engine.load)
            if self.closed:
                return
            failure_code = "WARMUP_FAILED"
            if not self.prewarmed:
                await self.status("warming-up")
                await loop.run_in_executor(self.executor, partial(self.engine.warmup, language=self.config["language"]))
            scorers = await loop.run_in_executor(self.executor, lambda: {s: self.scorer_factory() for s in self.config["enabledSources"]})
            if self.closed:
                return
            self.sources = {s: SourceState(s, self.settings, scorer) for s, scorer in scorers.items()}
            for state in self.sources.values():
                state.consumer = asyncio.create_task(self._consume(state))
            self.ready = True
            self.worker = asyncio.create_task(self._run())
            await self.status("ready")
            await self._flush_events()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            await self.error(failure_code, "Local model or VAD initialization failed", False)
            await self.status("error")
            await self._flush_events()

    async def _require(self, source=None):
        if not self.ready or self.failed or self.closed:
            raise ProtocolError("NOT_READY", "Transcription engine is unavailable", True)
        if source is not None and source not in self.sources:
            raise ProtocolError("SOURCE_DISABLED", "Audio source is disabled")

    async def anchor(self, source, sample, dropped=0, *, discontinuity=False):
        await self._require(source)
        state = self.sources[source]
        if self.paused:
            raise ProtocolError("NOT_READY", "Resume before anchoring a source", True)
        if state.anchored and not state.ended and not discontinuity:
            raise ProtocolError("INVALID_CONTROL", "Active source requires an explicit gap control")
        if sample < state.expected:
            raise ProtocolError("INVALID_CONTROL", "Source timeline cannot move backward")
        await asyncio.wait_for(state.inbox.join(), 15)
        await self._clear_source(state, sample)
        state.anchored, state.ended, state.ending = True, False, False
        state.accounting.upstream_dropped += dropped
        if dropped or discontinuity:
            await self.error("AUDIO_DROPPED", "Audio discontinuity reported by capture")
            await self.status("listening", metrics={"source": source, "queueDepth": self.queue.depth, "droppedSamples": dropped})

    async def _clear_source(self, state, sample, *, reset_expected=True):
        state.epoch += 1
        if state.current and state.current.provisional:
            await self._text(state.current, [], True)
        state.current = None
        if state.held is not None:
            self._drop_input(state, len(state.held), "context_reset")
            state.held = None
        state.buffer.reset(sample)
        state.vad.reset(sample)
        if reset_expected:
            state.expected = sample
        state.cursor = sample
        state.next_sequence = None
        state.frame_history.clear()
        state.final_through = max(state.final_through, sample)
        state.lost_through = sample
        state.anchored = False
        self.queue.clear(state.source)
        self._refresh_idle()

    def _drop_input(self, state, samples, reason):
        if not samples:
            return
        state.accounting.dropped[reason] += samples
        state.unreported_drops += samples
        reason_code = {"overflow": 1, "pause": 2, "shutdown": 3, "processing_failure": 4, "context_reset": 5}[reason]
        self.diagnostics.record("input_dropped", state.source, samples, reason=reason_code)

    def _discard_inbox(self, state, reason):
        while not state.inbox.empty():
            _, pcm = state.inbox.get_nowait()
            state.queued_samples -= len(pcm) // 2
            self._drop_input(state, len(pcm) // 2, reason)
            state.inbox.task_done()

    async def _report_input_drops(self, state):
        dropped, state.unreported_drops = state.unreported_drops, 0
        if dropped:
            await self.error("AUDIO_DROPPED", "Bounded input handoff discarded audio; numeric diagnostics contain the cause")
            await self.status("processing", metrics={"source": state.source,
                "queueDepth": self.queue.depth, "droppedSamples": dropped})

    async def ingest(self, frame):
        await self._require(frame.source)
        state = self.sources[frame.source]
        if self.paused or not state.anchored or state.ended or state.ending:
            raise ProtocolError("NOT_READY", "Source must be active and anchored before audio", True)
        if frame.metadata is not None:
            meta = frame.metadata
            if meta["startSample"] != state.expected:
                raise ProtocolError("INVALID_FRAME", "Frame sample clock does not match the source anchor")
            if state.next_sequence is not None and meta["sequence"] < state.next_sequence:
                raise ProtocolError("INVALID_FRAME", "Frame sequence moved backward")
            if state.next_sequence is not None and meta["sequence"] > state.next_sequence:
                self.diagnostics.record("sequence_gap", frame.source,
                    (meta["sequence"] - state.next_sequence) * 1600)
            state.next_sequence = meta["sequence"] + 1
            state.frame_history.append(dict(meta))
        start = state.expected
        state.expected += len(frame.pcm) // 2
        state.accounting.received += len(frame.pcm) // 2
        self.diagnostics.record("ingest_accepted", frame.source, len(frame.pcm) // 2)
        if state.inbox.full():
            _, old = state.inbox.get_nowait()
            state.queued_samples -= len(old) // 2
            self._drop_input(state, len(old) // 2, "overflow")
            state.inbox.task_done()
        state.inbox.put_nowait((start, frame.pcm))
        state.queued_samples += len(frame.pcm) // 2
        self.diagnostics.record("input_enqueued", frame.source, len(frame.pcm) // 2, depth=state.inbox.qsize())
        self.idle.clear()
        await asyncio.sleep(0)

    async def _consume(self, state):
        while not self.closed:
            start, pcm = await state.inbox.get()
            state.queued_samples -= len(pcm) // 2
            state.working = True
            state.active_input_samples = len(pcm) // 2
            try:
                self.diagnostics.record("input_dequeued", state.source, len(pcm) // 2, depth=state.inbox.qsize())
                await self._report_input_drops(state)
                held, state.held = state.held, None
                if held is not None:
                    await self._process(state, held)
                if start != state.cursor:
                    history = list(state.frame_history)
                    await self._clear_source(state, start, reset_expected=False)
                    state.frame_history.extend(f for f in history if f['startSample'] >= start)
                    state.anchored = True
                if self.paused or self.closed:
                    self._drop_input(state, state.active_input_samples, "pause" if self.paused else "shutdown")
                else:
                    state.held = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
                state.cursor = start + len(pcm) // 2
            except asyncio.CancelledError:
                self._drop_input(state, state.active_input_samples, "shutdown")
                raise
            except Exception:
                self._drop_input(state, state.active_input_samples, "processing_failure")
                state.active_input_samples = 0
                self.failed, self.ready = True, False
                self._discard_inbox(state, "processing_failure")
                if not self.emission_failed:
                    await self.error("AUDIO_PROCESSING_FAILED", "Local audio processing failed", False)
                    await self.status("error")
                return
            finally:
                state.active_input_samples = 0
                state.working = False
                state.inbox.task_done()
                self._refresh_idle()

    async def _process(self, state, samples):
        started = monotonic()
        state.processing_samples = len(samples)
        try:
            vad_started = monotonic()
            events = await asyncio.get_running_loop().run_in_executor(self.vad_executor, state.vad.feed, samples)
            self.diagnostics.record("vad_feed", state.source, len(samples),
                                    duration_ms=(monotonic() - vad_started) * 1000, **state.vad.last_stats)
            state.accounting.processed += len(samples)
            state.processing_samples = 0
            self.diagnostics.record("processed", state.source, len(samples), start=state.buffer.end)
            dropped = state.buffer.append(samples)
            self.diagnostics.record("buffered", state.source, len(samples), buffer_start=state.buffer.start,
                                    buffer_end=state.buffer.end, evicted_samples=dropped)
            if dropped:
                self.diagnostics.record("buffer_evicted", state.source, dropped)
            if dropped and state.current and state.current.agreement.committed_through < state.buffer.start:
                await self._loss(state, max(state.current.start, state.current.agreement.committed_through),
                                 state.buffer.start, "Uncommitted audio exceeded the bounded buffer")
            if not self.paused and not self.closed:
                await self._vad_events(state, events)
            if not self.paused and state.current:
                # Offer an early provisional hypothesis without increasing the
                # sustained inference rate on CPU. Later passes keep the normal
                # cadence and the queue still coalesces stale live snapshots.
                first_pass = state.current.last_pass_sample == state.current.start
                interval = min(self.settings.interval, 0.6) if first_pass else self.settings.interval
                if state.buffer.end - state.current.last_pass_sample >= interval * 16000:
                    await self._schedule(state, False, state.buffer.end)
            self.diagnostics.record("ingest_processing", state.source, duration_ms=(monotonic() - started) * 1000)
        except asyncio.CancelledError:
            self._drop_input(state, state.processing_samples, "shutdown")
            raise
        except Exception:
            self._drop_input(state, state.processing_samples, "processing_failure")
            raise
        finally:
            state.processing_samples = 0

    async def _vad_events(self, state, events):
        for event in events:
            self.diagnostics.record("vad_" + event.kind, state.source, sample=event.sample)
            if event.kind == "start":
                state.number += 1
                start = max(event.sample, state.buffer.start, state.final_through)
                state.current = Utterance(state.source, state.number, state.epoch, start,
                                          LocalAgreement(start), last_pass_sample=start)
            elif state.current:
                state.current.ended_at_ms = monotonic() * 1000
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
        await self._loss(state, max(utterance.start, utterance.agreement.committed_through),
                         start, "Uncommitted audio moved outside the rolling window")
        if self.paused or self.closed or utterance.epoch != state.epoch:
            self.diagnostics.record("snapshot_invalidated", state.source, len(samples))
            return
        provenance = tuple(dict(frame) for frame in state.frame_history
                           if frame["startSample"] < end and frame["startSample"] + frame["sampleCount"] > start)
        if self.queue.put(Job(utterance, samples, start, end, final, frames=provenance)):
            utterance.last_pass_sample = end
            self.idle.clear()
        else:
            await self.error("AUDIO_DROPPED", "Inference finalization queue reached its limit")
            await self._loss(state, max(start, utterance.agreement.committed_through), end,
                             "Finalization audio could not be queued")

    async def _loss(self, state, start, end, message):
        # Window cropping and later ring eviction can describe the same samples.
        # Count each lost source interval once, rather than summing both reports.
        lost = max(0, end - max(start, state.lost_through))
        state.lost_through = max(state.lost_through, end)
        if lost:
            reason = {"Uncommitted audio exceeded the bounded buffer": 1,
                      "Uncommitted audio moved outside the rolling window": 2,
                      "Finalization audio could not be queued": 3}.get(message, 0)
            self.diagnostics.record("context_lost", state.source, lost, reason=reason, start=start, end=end)
            await self.error("AUDIO_DROPPED", message)
            await self.status("processing", metrics={"source": state.source,
                "queueDepth": self.queue.depth, "droppedSamples": lost})

    def _event_timing(self, job, start, end):
        if job is None or not job.frames:
            return None
        first = next((f for f in job.frames if f["startSample"] <= start < f["startSample"] + f["sampleCount"]), None)
        last = next((f for f in job.frames if f["startSample"] < end <= f["startSample"] + f["sampleCount"]), None)
        if first is None or last is None:
            return None
        return {"clock": "sidecar-monotonic", "captureKind": last.get("captureKind", "replay"), "firstSequence": first["sequence"], "lastSequence": last["sequence"],
                "captureStartMs": first["captureTimeMs"] + (start - first["startSample"]) / 16,
                "captureEndMs": last["captureTimeMs"] + (end - last["startSample"]) / 16,
                "sentMs": last["sentMs"], "receivedMs": last["serverReceiveMs"],
                "inferenceStartMs": job.timing["worker_start"] * 1000,
                "inferenceEndMs": job.timing["worker_complete"] * 1000,
                "emittedMs": 0,
                **({"finalizationStartMs": job.utterance.ended_at_ms} if job.final and job.utterance.ended_at_ms is not None else {}),
                "uncertaintyMs": max(first["captureErrorMs"], last["captureErrorMs"])}

    async def _text(self, utterance, words, final, *, job=None):
        if not words and not utterance.provisional:
            return
        text = "".join(word.text if word.text.startswith(" ") else " " + word.text for word in words).strip()
        start = words[0].start if words else utterance.provisional_start
        end = words[-1].end if words else utterance.provisional_end
        chunk = utterance.chunk
        trace = {"utterance": utterance.number, "chunk": chunk, "generation": self.config["generation"],
                 "final": final, "words": len(words), "start": start, "end": end, "epoch": utterance.epoch,
                 "inference_origin": job is not None, "window_start": job.start if job else 0,
                 "window_end": job.end if job else 0, **(job.timing if job else {})}
        # Advance identity before yielding to the event sender or recording controls.
        if not final:
            utterance.provisional_start, utterance.provisional_end = start, end
        utterance.provisional = not final
        if final:
            utterance.chunk += 1
        self.diagnostics.record("text_emitting", utterance.source, **trace)
        timing = self._event_timing(job, start, end)
        event = {"type": "final" if final else "partial", "source": utterance.source,
                          "id": f"{self.config['sessionId']}:{self.config['generation']}:{utterance.source}:{utterance.number}:{chunk}",
                          "text": text, "startMs": round(start / 16), "endMs": round(end / 16),
                          **({"timing": timing} if timing else {})}
        keep, reason = self.dedup.inspect(event)
        self.diagnostics.record("dedup_" + reason, utterance.source)
        if not keep:
            # An empty final cancels any provisional row using the existing protocol.
            event["text"] = ""
        await self._emit(event, trace=trace)

    async def _run(self):
        loop = asyncio.get_running_loop()
        try:
            while not self.closed:
                job = await self.queue.get()
                if job is None:
                    break
                self.busy = True
                self.current_job = job
                dequeued = monotonic()
                wait_ms = (dequeued - job.created) * 1000
                last = self.last_dequeued.get(job.source, dequeued)
                self.last_dequeued[job.source] = dequeued
                self.diagnostics.record("inference_start", job.source, len(job.samples), start=job.start,
                    end=job.end, final=job.final, utterance=job.utterance.number, queue_wait_ms=wait_ms,
                    scheduling_interval_ms=(dequeued - last) * 1000, window_ms=len(job.samples) / 16)
                await self.status("processing")
                result = await loop.run_in_executor(self.executor, partial(
                    self.engine.transcribe_samples, job.samples, language=self.config["language"],
                    beam_size=self.settings.beam_size, offset=job.start))
                self.diagnostics.record("inference_complete", job.source, len(job.samples),
                    start=job.start, end=job.end, utterance=job.utterance.number, final=job.final,
                    duration_ms=result.inference_seconds * 1000, wall_ms=(monotonic() - dequeued) * 1000,
                    words=len(result.words), worker_start=getattr(result, "started_monotonic_seconds", 0),
                    worker_complete=getattr(result, "completed_monotonic_seconds", 0), segments_seen=getattr(result, "segments_seen", 0),
                    segments_filtered=getattr(result, "segments_filtered", 0),
                    words_outside_window=getattr(result, "words_outside_window", 0))
                state, utterance = self.sources[job.source], job.utterance
                state.accounting.infer(job.start, job.end)
                job.timing = {"worker_start": getattr(result, "started_monotonic_seconds", 0),
                              "worker_complete": getattr(result, "completed_monotonic_seconds", 0),
                              "duration_ms": result.inference_seconds * 1000, "queue_wait_ms": wait_ms}
                if not self.closed and not self.paused and utterance.epoch == state.epoch:
                    words = [word for word in result.words if word.end > state.final_through]
                    if job.final:
                        final = utterance.agreement.finish(words)
                        await self._text(utterance, final, True, job=job)
                    else:
                        if words:
                            utterance.live_passes += 1
                        stable, pending = utterance.agreement.update(words)
                        if stable:
                            await self._text(utterance, stable, True, job=job)
                        await self._text(utterance, pending, False, job=job)
                    state.final_through = max(state.final_through, utterance.agreement.committed_through)
                    trim = max(state.buffer.start, utterance.agreement.committed_through - round(self.settings.overlap_seconds * 16000))
                    trimmed = max(0, min(trim, state.buffer.end) - state.buffer.start)
                    state.buffer.trim(trim)
                    self.diagnostics.record("buffer_committed_trim", job.source, trimmed)
                    await self.status("listening", metrics={"source": job.source,
                        "inferenceMs": result.inference_seconds * 1000, "queueWaitMs": wait_ms,
                        "queueDepth": self.queue.depth, "droppedSamples": 0})
                self.busy = False
                self.current_job = None
                self._retire_coverage(state)
                self._refresh_idle()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            self.ready = False
            self.queue.clear()
            self.busy = False
            self.current_job = None
            self._refresh_idle()
            if not self.emission_failed:
                await self.error("INFERENCE_FAILED", "Local inference worker failed", False)
                await self.status("error")

    def _retire_coverage(self, state):
        starts = [state.buffer.start]
        starts.extend(job.start for job in self.queue.pending[state.source])
        if self.current_job is not None and self.current_job.source == state.source:
            starts.append(self.current_job.start)
        state.accounting.retire(min(starts))

    def accounting_snapshot(self, state):
        queued = state.queued_samples
        held = len(state.held) if state.held is not None else 0
        return state.accounting.snapshot(queued + held + state.active_input_samples + state.processing_samples)

    async def source_end(self, source, padding=0):
        await self._require(source)
        state = self.sources[source]
        if state.ended or state.ending:
            raise ProtocolError("INVALID_CONTROL", "Source already ended")
        if isinstance(padding, bool) or not isinstance(padding, int) or not 0 <= padding < 1600:
            raise ProtocolError("INVALID_CONTROL", "Invalid final frame padding")
        state.ending = True
        await asyncio.wait_for(state.inbox.join(), 15)
        await self._require(source)
        if state.held is None and padding:
            raise ProtocolError("INVALID_CONTROL", "Padding requires a final audio frame")
        if state.held is not None:
            held, state.held = state.held, None
            state.accounting.padding += padding
            await self._process(state, held[:1600 - padding])
            state.expected -= padding
        flush_events = await asyncio.get_running_loop().run_in_executor(self.vad_executor, state.vad.flush)
        self.diagnostics.record("source_end", source, padding, expected=state.expected)
        await self._vad_events(state, flush_events)
        if state.current:
            state.current.ended_at_ms = monotonic() * 1000
            await self._schedule(state, True, state.buffer.end)
            state.current = None
        state.ended = True
        await self._report_input_drops(state)

    async def pause(self):
        await self._require()
        if all(state.ended for state in self.sources.values()):
            await asyncio.wait_for(self.idle.wait(), 30)
            await self._flush_events()
        self.paused = True
        for state in self.sources.values():
            state.epoch += 1
            self._discard_inbox(state, "pause")
            await asyncio.wait_for(state.inbox.join(), 15)
            if state.held is not None:
                self._drop_input(state, len(state.held), "pause")
                state.held = None
            await self._clear_source(state, state.expected)
            await self._report_input_drops(state)
        await self._flush_events()

    async def resume(self):
        await self._require()
        self.paused = False  # sources require new measured anchors

    async def stop(self):
        try:
            await self._finish()
        finally:
            await self.close()

    async def _finish(self):
        if self.ready and not self.failed and not self.paused:
            for source, state in self.sources.items():
                if not state.ended:
                    await self.source_end(source)
            await asyncio.wait_for(self.idle.wait(), 30)
        await self._flush_events()

    async def close(self):
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._close())
        await asyncio.shield(self.close_task)

    async def _close(self):
        if self.closed:
            return
        self.closed = True
        self.ready = False
        for state in self.sources.values():
            self._discard_inbox(state, "shutdown")
            if state.consumer:
                state.consumer.cancel()
        await asyncio.gather(*(state.consumer for state in self.sources.values() if state.consumer), return_exceptions=True)
        self.queue.close()
        if self.current_job is not None:
            self.diagnostics.record("inference_abandoned_shutdown", self.current_job.source,
                len(self.current_job.samples), start=self.current_job.start, end=self.current_job.end)
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=True)
        await asyncio.to_thread(self.vad_executor.shutdown, wait=True, cancel_futures=True)
        self.current_job = None
        self.busy = False
        for state in self.sources.values():
            if state.held is not None:
                self._drop_input(state, len(state.held), "shutdown")
                state.held = None
            self.diagnostics.sample_accounting[state.source] = self.accounting_snapshot(state)
            state.buffer.reset(state.expected)
            state.current = None
        try:
            for state in self.sources.values():
                if not self.emission_failed:
                    await self._report_input_drops(state)
            if not self.emission_failed:
                await self._flush_events()
        except ProtocolError:
            if not self.emission_failed:
                raise
        finally:
            if self.sender:
                self.sender.cancel()
                await asyncio.gather(self.sender, return_exceptions=True)
            self._discard_events("event_discarded_shutdown")
