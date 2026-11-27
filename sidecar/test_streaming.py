import asyncio
from dataclasses import dataclass
import threading
import time

import numpy as np
import pytest

from sidecar.audio_buffer import AudioBuffer
from sidecar.engine import WordInference
from sidecar.local_agreement import Word
from sidecar.protocol import AudioFrame, ProtocolError, validate
from sidecar.scheduling import FairQueue
from sidecar.streaming import StreamingPipeline, StreamingSettings


class EnergyScore:
    def reset(self):
        pass

    def __call__(self, samples):
        return 0.9 if np.max(np.abs(samples)) > 0.01 else 0.0


class Engine:
    def __init__(self):
        self.loads = self.warmups = self.active = self.maximum = 0
        self.calls = []
        self.entered = threading.Event()
        self.release = None
        self.fail = False

    def load(self):
        self.loads += 1

    def warmup(self, **kwargs):
        self.warmups += 1

    def transcribe_samples(self, audio, *, offset, **kwargs):
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        self.calls.append(float(np.mean(audio)))
        self.entered.set()
        try:
            if self.release:
                self.release.wait(2)
            if self.fail:
                raise RuntimeError("private-runtime-marker")
            time.sleep(0.001)
            return WordInference((Word("scripted", offset + 160, offset + 1600),), 0.001)
        finally:
            self.active -= 1


def configuration():
    return {"model": "base.en", "language": "en", "sessionId": "00000000-0000-4000-8000-000000000001",
            "generation": 0, "enabledSources": ["mic", "system"]}


def frame(source, value=3000):
    return AudioFrame(source, np.full(1600, value, dtype="<i2").tobytes())


def test_audio_buffer_window_bounds_and_trim():
    buffer = AudioBuffer(3200, 16000)
    assert buffer.append(np.arange(1600)) == 0
    assert buffer.append(np.arange(3200)) == 1600
    assert buffer.start == 17600 and buffer.end == 20800
    audio, start = buffer.snapshot(18000, 19000)
    assert len(audio) == 1000 and start == 18000
    buffer.trim(20800)
    assert not buffer.chunks and not len(buffer.snapshot()[0])


@dataclass
class StubJob:
    source: str
    key: str
    final: bool = False


def test_fair_queue_coalesces_bounded_backpressure_and_round_robin():
    async def run():
        queue = FairQueue(["mic", "system"], 2)
        assert queue.put(StubJob("mic", "one"))
        assert queue.put(StubJob("mic", "one"))
        assert queue.depth == 1
        assert queue.put(StubJob("mic", "two", True))
        assert queue.put(StubJob("mic", "three", True))  # evicts stale partial
        assert not queue.put(StubJob("mic", "four", True))
        assert queue.put(StubJob("system", "remote", True))
        assert [(await queue.get()).source for _ in range(3)] == ["mic", "system", "mic"]
        queue.close()
        assert await queue.get() is None
    asyncio.run(run())


def test_one_model_two_independent_sources_partial_final_and_padding():
    async def run():
        events, engine = [], Engine()
        async def emit(event):
            validate("event", event)
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            assert engine.loads == engine.warmups == 1 and pipeline.ready
            await pipeline.anchor("mic", 0)
            await pipeline.anchor("system", 32000)
            for _ in range(12):
                await pipeline.ingest(frame("mic", 3000))
                await pipeline.ingest(frame("system", 6000))
            await asyncio.wait_for(pipeline.idle.wait(), 2)
            for _ in range(12):
                await pipeline.ingest(frame("mic", 3000))
                await pipeline.ingest(frame("system", 6000))
            await pipeline.source_end("mic", 123)
            await pipeline.source_end("system", 321)
            await pipeline.stop()
            assert engine.maximum == 1 and engine.loads == 1
            texts = [e for e in events if e["type"] in ("partial", "final") and e["text"]]
            assert {e["source"] for e in texts} == {"mic", "system"}
            finals = [e for e in texts if e["type"] == "final"]
            assert len({e["id"] for e in finals}) == len(finals)
            assert all(e["startMs"] >= 2000 for e in texts if e["source"] == "system")
            assert pipeline.sources["mic"].expected == 24 * 1600 - 123
            assert pipeline.sources["system"].expected == 32000 + 24 * 1600 - 321
        finally:
            await pipeline.close()
    asyncio.run(run())


def test_silence_does_not_run_inference_or_emit_transcripts():
    async def run():
        events, engine = [], Engine()
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        await pipeline.start()
        for source in ("mic", "system"):
            await pipeline.anchor(source, 0)
            for _ in range(30):
                await pipeline.ingest(frame(source, 0))
        await pipeline.stop()
        assert not engine.calls
        assert not [e for e in events if e["type"] in ("partial", "final")]
    asyncio.run(run())


def test_first_partial_is_scheduled_early_without_increasing_sustained_cadence():
    async def run():
        events, engine = [], Engine()
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            await pipeline.anchor("mic", 0)
            for _ in range(8):
                await pipeline.ingest(frame("mic"))
            await asyncio.wait_for(pipeline.idle.wait(), 2)
            assert len(engine.calls) == 1
            assert any(event["type"] == "partial" and event["text"] for event in events)
            for _ in range(4):
                await pipeline.ingest(frame("mic"))
            await asyncio.wait_for(pipeline.idle.wait(), 2)
            assert len(engine.calls) == 1
        finally:
            await pipeline.close()
    asyncio.run(run())


def test_forward_capture_gap_reports_loss_and_transcribes_from_the_new_anchor():
    async def run():
        events, engine = [], Engine()
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            await pipeline.anchor("mic", 0)
            for _ in range(8):
                await pipeline.ingest(frame("mic"))
            await asyncio.wait_for(pipeline.idle.wait(), 2)
            await pipeline.anchor("mic", 32000, dropped=19200, discontinuity=True)
            after_gap = len(events)
            for _ in range(8):
                await pipeline.ingest(frame("mic"))
            await pipeline.source_end("mic")
            await pipeline.stop()
            resumed = [event for event in events[after_gap:] if event["type"] in ("partial", "final") and event["text"]]
            assert resumed and all(event["startMs"] >= 2000 for event in resumed)
            assert any(event["type"] == "final" for event in resumed)
            assert any(event.get("code") == "AUDIO_DROPPED" and event["recoverable"] for event in events)
            assert not pipeline.failed
        finally:
            await pipeline.close()
    asyncio.run(run())


def test_pause_invalidates_inflight_results_and_resume_requires_anchor():
    async def run():
        events, engine = [], Engine()
        engine.release = threading.Event()
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        await pipeline.start()
        try:
            await pipeline.anchor("mic", 0)
            for _ in range(12):
                await pipeline.ingest(frame("mic"))
            assert await asyncio.to_thread(engine.entered.wait, 1)
            await pipeline.pause()
            engine.release.set()
            await asyncio.wait_for(pipeline.idle.wait(), 2)
            assert not [e for e in events if e["type"] in ("partial", "final")]
            await pipeline.resume()
            with pytest.raises(ProtocolError):
                await pipeline.ingest(frame("mic"))
            await pipeline.anchor("mic", 64000)
            await pipeline.ingest(frame("mic"))
            await pipeline.source_end("mic")
            await pipeline.stop()
        finally:
            engine.release.set()
            await pipeline.close()
    asyncio.run(run())


def test_pause_preserves_final_words_when_capture_explicitly_ended_all_sources():
    async def run():
        events, engine = [], Engine()
        engine.release = threading.Event()
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        await pipeline.start()
        try:
            for source in ("mic", "system"):
                await pipeline.anchor(source, 0)
                for _ in range(12):
                    await pipeline.ingest(frame(source))
                await pipeline.source_end(source)
            assert await asyncio.to_thread(engine.entered.wait, 1)
            paused = asyncio.create_task(pipeline.pause())
            await asyncio.sleep(0)
            assert not paused.done()
            engine.release.set()
            await asyncio.wait_for(paused, 2)
            assert {event["source"] for event in events if event["type"] == "final" and event["text"]} == {"mic", "system"}
            assert pipeline.paused
        finally:
            engine.release.set()
            await pipeline.close()
    asyncio.run(run())


def test_model_errors_and_warmup_failures_are_safe_and_never_ready():
    async def run():
        events, engine = [], Engine()
        async def emit(event):
            events.append(event)
        def fail():
            raise RuntimeError("private-marker")
        engine.load = fail
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            assert not pipeline.ready and pipeline.failed
            assert events[-2]["code"] == "MODEL_LOAD_FAILED"
            assert "private-marker" not in str(events)
        finally:
            await pipeline.close()
    asyncio.run(run())


def test_lost_audio_intervals_are_not_counted_twice():
    async def run():
        events = []
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=Engine(), scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            state = pipeline.sources["mic"]
            await pipeline._loss(state, 0, 1600, "scripted crop")
            await pipeline._loss(state, 0, 1600, "same samples evicted later")
            await pipeline._loss(state, 0, 3200, "next lost interval")
            assert sum(e.get("metrics", {}).get("droppedSamples", 0) for e in events) == 3200
        finally:
            await pipeline.close()
    asyncio.run(run())


@pytest.mark.parametrize("kwargs", [dict(window_seconds=0), dict(buffer_seconds=100), dict(queue_per_source=0)])
def test_settings_bounds(kwargs):
    with pytest.raises(ValueError):
        StreamingSettings(**kwargs)
