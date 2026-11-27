import asyncio
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
import uuid

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from sidecar.protocol import validate
from sidecar.server import SidecarServer


def transport_server(*args, **kwargs):
    return SidecarServer(*args, pipeline_factory=None, **kwargs)


def config(server, token):
    return dict(type="config", protocolVersion=1, sessionId=server.session_id,
                generation=server.generation, token=token, sampleRate=16000,
                channels=1, encoding="pcm_s16le", frameMs=100, model="base.en",
                language="en", enabledSources=["mic", "system"])


def control(server, kind="ping", **overrides):
    return {"type": kind, "sessionId": server.session_id, "generation": server.generation,
            "requestId": str(uuid.uuid4()), **overrides}


async def receive(socket, timeout=2):
    return validate("event", json.loads(await asyncio.wait_for(socket.recv(), timeout)))


async def authenticated(server, token):
    socket = await connect(f"ws://127.0.0.1:{server.port}", proxy=None)
    await socket.send(json.dumps(config(server, token)))
    assert (await receive(socket))["status"] == "starting"
    return socket


def test_bind_config_health_stop_and_cleanup():
    async def run():
        token = secrets.token_hex(32)
        server = transport_server(token, str(uuid.uuid4()), 0)
        async with server:
            assert all(s.getsockname()[0] == "127.0.0.1" for s in server._server.sockets)
            assert server.port > 0
            socket = await authenticated(server, token)
            ping = control(server)
            await socket.send(json.dumps(ping))
            assert (await receive(socket))["requestId"] == ping["requestId"]
            stop = control(server, "stop")
            await socket.send(json.dumps(stop))
            assert await receive(socket) == {"type": "status", "sessionId": server.session_id,
                                             "generation": 0, "status": "stopped", "requestId": stop["requestId"]}
            await asyncio.wait_for(socket.wait_closed(), 2)
            await asyncio.wait_for(server.finished.wait(), 2)
            assert server.session.closed and not server.session._requests
            assert server._owner is None and server._token == ""
        assert not server._server.sockets
    asyncio.run(run())


@pytest.mark.parametrize("case", ["wrong-token", "missing-token", "expired", "session", "generation", "binary", "model", "malformed"])
def test_authentication_rejections(case):
    async def run():
        token = secrets.token_hex(32)
        now = [0.0]
        async with transport_server(token, str(uuid.uuid4()), 0, clock=lambda: now[0]) as server:
            payload = config(server, token)
            expected = "AUTH_FAILED"
            if case == "wrong-token":
                payload["token"] = secrets.token_hex(32)
            elif case == "missing-token":
                payload.pop("token")
                expected = "INVALID_CONFIG"
            elif case == "expired":
                now[0] = 31
                expected = "AUTH_EXPIRED"
            elif case == "session":
                payload["sessionId"] = str(uuid.uuid4())
            elif case == "generation":
                payload["generation"] = 1
            elif case == "model":
                payload["model"] = "unsupported"
                expected = "UNSUPPORTED_MODEL"
            else:
                expected = "INVALID_CONFIG"
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as socket:
                await socket.send(b"\0" + bytes(3200) if case == "binary" else "{" if case == "malformed" else json.dumps(payload))
                error = await receive(socket)
                assert error["code"] == expected
                assert error["sessionId"] is None
                await socket.wait_closed()
            assert server.session is None and not server._consumed
    asyncio.run(run())


def test_auth_deadline():
    async def run():
        async with transport_server(secrets.token_hex(32), str(uuid.uuid4()), 0, auth_timeout=0.03) as server:
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as socket:
                assert (await receive(socket))["code"] == "AUTH_FAILED"
                await socket.wait_closed()
    asyncio.run(run())


def test_single_owner_and_revocation_on_disconnect():
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            first = await authenticated(server, token)
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as other:
                await other.send(json.dumps(config(server, token)))
                assert (await receive(other))["code"] == "AUTH_FAILED"
            await first.close()
            await asyncio.wait_for(server.finished.wait(), 2)
            assert server.session.closed and server._owner is None
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as other:
                await other.send(json.dumps(config(server, token)))
                assert (await receive(other))["code"] == "AUTH_FAILED"
    asyncio.run(run())


@pytest.mark.parametrize("payload,expected", [(b"", "INVALID_FRAME"), (bytes(3200), "INVALID_FRAME"),
                                             (bytes(3202), "INVALID_FRAME"), (b"\2" + bytes(3200), "INVALID_FRAME"),
                                             (b"\1" + bytes(3200), "SOURCE_DISABLED")])
def test_invalid_binary_frames_after_auth(payload, expected):
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            async with connect(f"ws://127.0.0.1:{server.port}", proxy=None) as socket:
                conf = config(server, token)
                conf["enabledSources"] = ["mic"]
                await socket.send(json.dumps(conf))
                await receive(socket)
                await socket.send(payload)
                assert (await receive(socket))["code"] == expected
                await socket.wait_closed()
            assert server.session.closed
    asyncio.run(run())


def test_valid_audio_is_explicitly_not_ready_and_no_transcript_is_fabricated():
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            socket = await authenticated(server, token)
            for identity in (0, 1):
                await socket.send(bytes([identity]) + bytes(3200))
                event = await receive(socket)
                assert event["code"] == "NOT_READY" and event["recoverable"]
            await socket.send(json.dumps(control(server)))
            assert (await receive(socket))["status"] == "starting"
            await socket.close()
    asyncio.run(run())


@pytest.mark.parametrize("case", ["stale", "duplicate", "invalid-json", "extra-field", "reconfigure"])
def test_control_validation(case):
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            socket = await authenticated(server, token)
            payload = control(server)
            expected = "INVALID_CONTROL"
            if case == "stale":
                payload["generation"] = 1
                expected = "STALE_SESSION"
            elif case == "duplicate":
                await socket.send(json.dumps(payload))
                await receive(socket)
                expected = "DUPLICATE_REQUEST"
            elif case == "extra-field":
                payload["unexpected"] = True
            elif case == "reconfigure":
                payload = config(server, token)
            await socket.send("{" if case == "invalid-json" else json.dumps(payload))
            assert (await receive(socket))["code"] == expected
            await socket.wait_closed()
    asyncio.run(run())


def test_oversized_message_transport_limit():
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            socket = await authenticated(server, token)
            await socket.send(bytes(4097))
            with pytest.raises(ConnectionClosed) as error:
                await socket.recv()
            assert error.value.rcvd.code == 1009
            await asyncio.wait_for(server.finished.wait(), 2)
    asyncio.run(run())


def test_cli_readiness_actual_process_and_stdout_privacy():
    async def run():
        token, session_id = secrets.token_hex(32), str(uuid.uuid4())
        environment = {**os.environ, "VINXA_SIDECAR_TOKEN": token,
                       "VINXA_SIDECAR_SESSION_ID": session_id, "VINXA_SIDECAR_GENERATION": "0"}
        process = await asyncio.create_subprocess_exec(sys.executable, "-m", "sidecar.server",
                                                       cwd=Path(__file__).resolve().parents[1], env=environment,
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            line = await asyncio.wait_for(process.stdout.readline(), 10)
            handshake = validate("listening", json.loads(line))
            async with connect(f"ws://127.0.0.1:{handshake['port']}", proxy=None) as socket:
                payload = {**json.loads(Path(__file__).with_name("fixtures").joinpath("protocol.json").read_text())["bases"]["config"],
                           "sessionId": session_id, "token": token}
                await socket.send(json.dumps(payload))
                assert (await receive(socket))["status"] == "starting"
                await socket.send(json.dumps({"type": "stop", "sessionId": session_id,
                                               "generation": 0, "requestId": str(uuid.uuid4())}))
                while (await receive(socket, timeout=20)).get("status") != "stopped":
                    pass
            stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
            assert process.returncode == 0 and stdout == b"" and stderr == b""
            assert token.encode() not in line
        finally:
            if process.returncode is None:
                process.kill()
                await process.communicate()
    asyncio.run(run())


def test_concurrent_authentication_has_exactly_one_owner():
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            first, second = await asyncio.gather(*[connect(f"ws://127.0.0.1:{server.port}", proxy=None) for _ in range(2)])
            try:
                await asyncio.gather(first.send(json.dumps(config(server, token))), second.send(json.dumps(config(server, token))))
                events = await asyncio.gather(receive(first), receive(second))
                assert sorted(event["type"] for event in events) == ["error", "status"]
                assert next(event for event in events if event["type"] == "error")["code"] == "AUTH_FAILED"
            finally:
                await asyncio.gather(first.close(), second.close())
    asyncio.run(run())


def test_unclaimed_admission_expires_and_shutdown_closes_active_client():
    async def run():
        async with transport_server(secrets.token_hex(32), str(uuid.uuid4()), 0, admission_seconds=0.03) as server:
            await asyncio.wait_for(server.finished.wait(), 1)
            assert server.session is None
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            socket = await authenticated(server, token)
        await asyncio.wait_for(socket.wait_closed(), 1)
        assert server.session.closed and server._owner is None
    asyncio.run(run())


def test_browser_origin_and_url_credentials_rejected_without_logging(caplog):
    async def run():
        token = secrets.token_hex(32)
        async with transport_server(token, str(uuid.uuid4()), 0) as server:
            with pytest.raises(InvalidStatus):
                async with connect(f"ws://127.0.0.1:{server.port}", origin="https://example.invalid", proxy=None):
                    pass
            async with connect(f"ws://127.0.0.1:{server.port}/?token=forbidden-marker", proxy=None) as socket:
                assert (await receive(socket))["code"] == "INVALID_CONFIG"
            assert "forbidden-marker" not in caplog.text and token not in caplog.text
    asyncio.run(run())


def test_startup_failure_has_safe_message_only():
    async def run():
        environment = {**os.environ, "VINXA_SIDECAR_TOKEN": "", "VINXA_SIDECAR_SESSION_ID": "private-marker"}
        process = await asyncio.create_subprocess_exec(sys.executable, "-m", "sidecar.server", env=environment,
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
            assert process.returncode == 1 and stdout == b""
            assert stderr.decode().splitlines() == ["Sidecar startup or transport failed; verify local runtime configuration."]
        finally:
            if process.returncode is None:
                process.kill()
                await process.communicate()
    asyncio.run(run())


def test_missing_packaged_schema_has_no_traceback_or_sensitive_path(tmp_path):
    package = tmp_path / "sidecar"
    package.mkdir()
    for name in ("__init__.py", "server.py", "protocol.py", "session.py"):
        shutil.copyfile(Path(__file__).with_name(name), package / name)

    async def run():
        process = await asyncio.create_subprocess_exec(sys.executable, "-m", "sidecar.server", cwd=tmp_path,
                                                       env={**os.environ, "PYTHONPATH": str(tmp_path)},
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
            assert process.returncode == 1 and stdout == b""
            assert stderr.decode().splitlines() == ["Sidecar startup or transport failed; verify local runtime configuration."]
        finally:
            if process.returncode is None:
                process.kill()
                await process.communicate()
    asyncio.run(run())
