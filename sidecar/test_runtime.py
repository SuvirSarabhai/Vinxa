import asyncio
import json
import secrets
import threading
import uuid

from websockets.asyncio.client import connect

from sidecar.server import SidecarServer
from sidecar.streaming import StreamingPipeline
from sidecar.test_server import config, control, receive
from sidecar.test_streaming import Engine, EnergyScore


async def until(socket, predicate, timeout=3):
    async with asyncio.timeout(timeout):
        while True:
            event = await receive(socket)
            if predicate(event):
                return event


def test_runtime_load_warmup_ready_frames_final_stop():
    async def run():
        token, engine, events = secrets.token_hex(32), Engine(), []
        def factory(configuration, emit):
            async def capture(event):
                events.append(event)
                await emit(event)
            return StreamingPipeline(configuration, capture, engine=engine, scorer_factory=EnergyScore)
        async with SidecarServer(token, str(uuid.uuid4()), 0, pipeline_factory=factory) as server:
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as socket:
                await socket.send(json.dumps(config(server, token)))
                await until(socket, lambda e: e.get("status") == "ready")
                assert [e["status"] for e in events[:3]] == ["loading", "warming-up", "ready"]
                for source, identity in (("mic", 0), ("system", 1)):
                    start = control(server, "source-start", source=source, startSample=0)
                    await socket.send(json.dumps(start))
                    await until(socket, lambda e: e.get("requestId") == start["requestId"])
                    for _ in range(15):
                        await socket.send(bytes([identity]) + b"\x00\x10" * 1600)
                stop = control(server, "stop")
                await socket.send(json.dumps(stop))
                await until(socket, lambda e: e.get("status") == "stopped")
            assert engine.loads == engine.warmups == engine.maximum == 1
            assert {e["source"] for e in events if e["type"] == "final" and e["text"]} == {"mic", "system"}
            assert server.pipeline.closed
    asyncio.run(run())


def test_health_while_loading_and_stop_cancels_ready():
    async def run():
        token, engine = secrets.token_hex(32), Engine()
        entered, release = threading.Event(), threading.Event()
        def load():
            entered.set()
            release.wait(3)
        engine.load = load
        def factory(configuration, emit):
            return StreamingPipeline(configuration, emit, engine=engine, scorer_factory=EnergyScore)
        async with SidecarServer(token, str(uuid.uuid4()), 0, pipeline_factory=factory) as server:
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as socket:
                try:
                    await socket.send(json.dumps(config(server, token)))
                    await until(socket, lambda e: e.get("status") == "loading")
                    ping = control(server)
                    await socket.send(json.dumps(ping))
                    event = await until(socket, lambda e: e.get("requestId") == ping["requestId"])
                    assert event["status"] == "loading"
                    await socket.send(b"\0" + bytes(3200))
                    assert (await receive(socket))["code"] == "NOT_READY"
                    await socket.send(json.dumps(control(server, "stop")))
                    release.set()
                    await until(socket, lambda e: e.get("status") == "stopped")
                    assert not server.pipeline.ready
                finally:
                    release.set()
    asyncio.run(run())


def test_failed_model_never_publishes_ready_or_raw_exception():
    async def run():
        token, engine, captured = secrets.token_hex(32), Engine(), []
        def fail():
            raise RuntimeError("private-error-marker")
        engine.warmup = fail
        def factory(configuration, emit):
            async def capture(event):
                captured.append(event)
                await emit(event)
            return StreamingPipeline(configuration, capture, engine=engine, scorer_factory=EnergyScore)
        async with SidecarServer(token, str(uuid.uuid4()), 0, pipeline_factory=factory) as server:
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as socket:
                await socket.send(json.dumps(config(server, token)))
                assert (await until(socket, lambda e: e["type"] == "error"))["code"] == "WARMUP_FAILED"
                await socket.wait_closed()
            await asyncio.wait_for(server.finished.wait(), 3)
        assert not any(e.get("status") == "ready" for e in captured)
        assert "private-error-marker" not in str(captured)
    asyncio.run(run())
