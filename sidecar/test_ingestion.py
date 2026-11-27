import asyncio
import threading

import pytest

from sidecar.protocol import ProtocolError
from sidecar.sample_accounting import SampleAccounting
from sidecar.streaming import StreamingPipeline, StreamingSettings
from sidecar.test_streaming import Engine, EnergyScore, configuration, frame


def assert_conserved(pipeline):
    for state in pipeline.sources.values():
        snapshot = pipeline.accounting_snapshot(state)
        assert snapshot["unexplained_samples"] == 0
        assert snapshot["pending_samples"] == 0
        assert snapshot["processed_without_inference_samples"] >= 0


def test_overlapping_inference_coverage_is_unique_and_history_is_retired():
    accounting = SampleAccounting()
    accounting.infer(0, 100)
    accounting.infer(50, 150)
    accounting.infer(75, 125)
    assert accounting.inferred == 150
    accounting.retire(100)
    accounting.infer(125, 200)
    assert accounting.inferred == 200
    assert accounting.coverage == [(100, 200)]
    for start in range(200, 10000, 100):
        accounting.infer(start, start + 100)
        accounting.retire(start + 100)
    assert accounting.inferred == 10000
    assert accounting.coverage == []
    with pytest.raises(ValueError):
        accounting.infer(0, 100)


def test_blocked_mic_vad_does_not_block_ingestion_or_system_and_overflow_is_counted():
    async def run():
        entered, release = threading.Event(), threading.Event()
        class BlockingScore(EnergyScore):
            def __call__(self, samples):
                entered.set()
                release.wait(3)
                return super().__call__(samples)
        scorers = iter([BlockingScore(), EnergyScore()])
        events = []
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=Engine(),
            settings=StreamingSettings(input_frames_per_source=2), scorer_factory=lambda: next(scorers))
        try:
            await pipeline.start()
            await pipeline.anchor("mic", 0)
            await pipeline.anchor("system", 0)
            await pipeline.ingest(frame("mic"))
            await pipeline.ingest(frame("mic"))
            assert await asyncio.to_thread(entered.wait, 1)
            async def send():
                for _ in range(6):
                    await pipeline.ingest(frame("mic"))
                for _ in range(12):
                    await pipeline.ingest(frame("system"))
                    await pipeline.sources["system"].inbox.join()
            await asyncio.wait_for(send(), 1)
            mic = pipeline.sources["mic"]
            assert mic.inbox.qsize() == 2
            assert mic.accounting.dropped["overflow"] == 4 * 1600
            assert pipeline.sources["system"].accounting.processed == 11 * 1600
            assert pipeline.accounting_snapshot(mic)["unexplained_samples"] == 0
            release.set()
            await pipeline.source_end("mic", 123)
            await pipeline.source_end("system", 321)
            await pipeline.stop()
            assert_conserved(pipeline)
            reported = sum(e.get("metrics", {}).get("droppedSamples", 0) for e in events)
            assert reported >= 4 * 1600
            assert mic.expected == 8 * 1600 - 123
            assert any(e["source"] == "system" and e["type"] == "final" for e in events if "source" in e)
        finally:
            release.set()
            await pipeline.close()
    asyncio.run(run())


def test_slow_model_keeps_both_ingestion_queues_moving_and_pause_conserves_samples():
    async def run():
        engine = Engine()
        engine.release = threading.Event()
        events = []
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            for source in ("mic", "system"):
                await pipeline.anchor(source, 0)
            for _ in range(12):
                await pipeline.ingest(frame("mic"))
                await pipeline.ingest(frame("system"))
            assert await asyncio.to_thread(engine.entered.wait, 1)
            for _ in range(10):
                for source in ("mic", "system"):
                    await pipeline.ingest(frame(source))
            await asyncio.wait_for(asyncio.gather(*(s.inbox.join() for s in pipeline.sources.values())), 1)
            assert all(s.accounting.processed == 21 * 1600 for s in pipeline.sources.values())
            assert all(s.accounting.dropped["overflow"] == 0 for s in pipeline.sources.values())
            await pipeline.pause()
            engine.release.set()
            await asyncio.wait_for(pipeline.idle.wait(), 2)
            await pipeline.resume()
            await pipeline.anchor("mic", 64000)
            await pipeline.ingest(frame("mic"))
            await pipeline.source_end("mic", 299)
            await pipeline.stop()
            assert_conserved(pipeline)
            assert all(s.accounting.dropped["pause"] == 1600 for s in pipeline.sources.values())
        finally:
            engine.release.set()
            await pipeline.close()
    asyncio.run(run())


def test_stalled_event_delivery_keeps_input_bounded_and_shutdown_accounts_for_it():
    async def run():
        release = asyncio.Event()
        blocked = asyncio.Event()
        enabled = False
        async def emit(event):
            if enabled:
                blocked.set()
                await release.wait()
        pipeline = StreamingPipeline(configuration(), emit, engine=Engine(),
            settings=StreamingSettings(input_frames_per_source=2, event_queue_size=4), scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            await pipeline.anchor("mic", 0)
            enabled = True
            await pipeline.status("processing")
            await asyncio.wait_for(blocked.wait(), 1)
            for _ in range(30):
                await pipeline.ingest(frame("mic"))
            assert pipeline.sources["mic"].inbox.qsize() <= 2
            assert pipeline.sources["mic"].accounting.dropped["overflow"] > 0
            assert pipeline.accounting_snapshot(pipeline.sources["mic"])["unexplained_samples"] == 0
            release.set()
            await pipeline.stop()
            assert_conserved(pipeline)
        finally:
            release.set()
            await pipeline.close()
    asyncio.run(run())


def test_vad_failure_reports_safe_error_and_accounts_for_pending_frames():
    async def run():
        class FailedScore(EnergyScore):
            def __call__(self, samples):
                raise RuntimeError("private-native-phrase")
        events = []
        async def emit(event):
            events.append(event)
        pipeline = StreamingPipeline(configuration(), emit, engine=Engine(), scorer_factory=FailedScore)
        try:
            await pipeline.start()
            await pipeline.anchor("mic", 0)
            await pipeline.ingest(frame("mic"))
            await pipeline.ingest(frame("mic"))
            await asyncio.wait_for(pipeline.sources["mic"].inbox.join(), 1)
            assert pipeline.failed and not pipeline.ready
            await pipeline.stop()
            assert_conserved(pipeline)
            assert pipeline.sources["mic"].accounting.dropped["processing_failure"] == 3200
            assert any(e.get("code") == "AUDIO_PROCESSING_FAILED" for e in events)
            assert "private-native-phrase" not in str(events)
        finally:
            await pipeline.close()
    asyncio.run(run())


def test_failed_event_sender_releases_backpressured_producers_and_closes():
    async def run():
        release = asyncio.Event()
        fail = False
        async def emit(event):
            if fail:
                await release.wait()
                raise RuntimeError("private-transport-phrase")
        pipeline = StreamingPipeline(configuration(), emit, engine=Engine(),
            settings=StreamingSettings(event_queue_size=4), scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            fail = True
            for _ in range(5):
                await pipeline.status("processing")
            waiting = asyncio.create_task(pipeline.status("processing"))
            await asyncio.sleep(0)
            assert not waiting.done()
            release.set()
            with pytest.raises(ProtocolError, match="Local event delivery failed"):
                await asyncio.wait_for(waiting, 1)
            assert pipeline.emission_failed and not pipeline.ready
            await asyncio.wait_for(pipeline.close(), 1)
            assert pipeline.sender.done()
            assert pipeline.outbox.empty()
        finally:
            release.set()
            await pipeline.close()
    asyncio.run(run())


def test_concurrent_shutdown_keeps_accounting_when_drop_notification_cannot_be_delivered():
    async def run():
        fail = False
        async def emit(event):
            if fail:
                raise RuntimeError("private-transport-phrase")
        pipeline = StreamingPipeline(configuration(), emit, engine=Engine(), scorer_factory=EnergyScore)
        await pipeline.start()
        await pipeline.anchor("mic", 0)
        await pipeline.ingest(frame("mic"))
        await pipeline.sources["mic"].inbox.join()
        fail = True
        await asyncio.wait_for(asyncio.gather(pipeline.close(), pipeline.close()), 1)
        assert_conserved(pipeline)
        assert pipeline.closed and pipeline.sender.done()
        saved = pipeline.diagnostics.sample_accounting["mic"]
        assert saved["received_samples"] == saved["input_dropped_samples"] == 1600
        assert saved["input_drop_reasons"] == {"shutdown": 1600}
        assert saved["unexplained_samples"] == 0
    asyncio.run(run())


def test_abrupt_close_releases_inflight_snapshot_after_native_worker_returns():
    async def run():
        engine = Engine()
        engine.release = threading.Event()
        async def emit(event):
            pass
        pipeline = StreamingPipeline(configuration(), emit, engine=engine, scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            await pipeline.anchor("mic", 0)
            for _ in range(12):
                await pipeline.ingest(frame("mic"))
            assert await asyncio.to_thread(engine.entered.wait, 1)
            assert pipeline.current_job is not None
            closing = asyncio.create_task(pipeline.close())
            await asyncio.sleep(0)
            engine.release.set()
            await asyncio.wait_for(closing, 1)
            assert pipeline.current_job is None and not pipeline.busy
            assert pipeline.worker.done()
            assert all(not state.buffer.chunks for state in pipeline.sources.values())
            assert_conserved(pipeline)
        finally:
            engine.release.set()
            await pipeline.close()
    asyncio.run(run())
