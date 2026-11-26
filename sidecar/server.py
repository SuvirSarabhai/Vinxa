"""Authenticated Stage 2 localhost transport. No capture or inference starts here."""

import asyncio
import hmac
import json
import logging
import os
import re
import signal
import sys
from time import monotonic

_STARTUP_ERROR = "Sidecar startup or transport failed; verify local runtime configuration.\n"
try:
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed

    from .protocol import MAX_MESSAGE_BYTES, ProtocolError, encode_event, parse_frame, parse_json, validate
    from .session import Session
except Exception:
    if __name__ == "__main__":
        sys.stderr.write(_STARTUP_ERROR)
        raise SystemExit(1) from None
    raise RuntimeError("Sidecar dependencies or wire schema are unavailable") from None

# WebSocket library debug/error output can contain peer data. Use safe errors only.
_logger = logging.Logger("vinxa.sidecar.transport")
_logger.addHandler(logging.NullHandler())
_logger.propagate = False
_DEFAULT_PIPELINE = object()


class SidecarServer:
    def __init__(self, token: str, session_id: str, generation: int, *,
                 auth_timeout=10.0, admission_seconds=30.0, clock=monotonic,
                 pipeline_factory=_DEFAULT_PIPELINE):
        # Use the approved schema for trusted launch identity too.
        validate("control", {"type": "ping", "sessionId": session_id, "generation": generation,
                             "requestId": "00000000-0000-4000-8000-000000000001"})
        if not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{64}", token) is None:
            raise ProtocolError("INVALID_LAUNCH", "Invalid sidecar launch configuration")
        if not 0 < auth_timeout <= 10 or not 0 < admission_seconds <= 30:
            raise ProtocolError("INVALID_LAUNCH", "Invalid sidecar launch deadlines")
        self._token = token
        self.session_id, self.generation = session_id, generation
        self.auth_timeout, self.admission_seconds, self.clock = auth_timeout, admission_seconds, clock
        self.session = None
        self._owner = None
        self._consumed = False
        self._server = None
        self._expiry_task = None
        self._active = 0
        self.finished = asyncio.Event()
        if pipeline_factory is _DEFAULT_PIPELINE:
            from .streaming import StreamingPipeline
            pipeline_factory = StreamingPipeline
        self.pipeline_factory = pipeline_factory
        self.pipeline = self._boot = None

    @property
    def port(self):
        return self._server.sockets[0].getsockname()[1]

    async def __aenter__(self):
        self._server = await serve(self._handle, "127.0.0.1", 0, origins=[None],
                                   compression=None, max_size=MAX_MESSAGE_BYTES, max_queue=4,
                                   open_timeout=5, close_timeout=1, write_limit=16384,
                                   logger=_logger, server_header=None)
        self._deadline = self.clock() + self.admission_seconds
        self._expiry_task = asyncio.create_task(self._expire_unclaimed())
        return self

    async def _expire_unclaimed(self):
        await asyncio.sleep(self.admission_seconds)
        if not self._consumed:
            self.finished.set()

    async def __aexit__(self, *args):
        self._expiry_task.cancel()
        await asyncio.gather(self._expiry_task, return_exceptions=True)
        self._server.close()
        await self._server.wait_closed()
        if self.session is not None:
            self.session.close()
        self._owner = None
        self._token = ""

    async def _error(self, socket, code, message, recoverable=False, authenticated=False):
        await socket.send(encode_event({"type": "error", "code": code, "message": message,
                                       "recoverable": recoverable,
                                       "sessionId": self.session_id if authenticated else None,
                                       "generation": self.generation if authenticated else None}))

    async def _close_pipeline(self, flush=False):
        if self._boot:
            self._boot.cancel()
            await asyncio.gather(self._boot, return_exceptions=True)
            self._boot = None
        if self.pipeline:
            if flush:
                await self.pipeline.stop()
            else:
                await self.pipeline.close()

    async def _handle(self, socket):
        if self._active >= 4:
            await socket.close(1008, "Connection limit")
            return
        self._active += 1
        owns = False
        try:
            if socket.request.path != "/":
                raise ProtocolError("INVALID_CONFIG", "Use the localhost root endpoint without URL credentials")
            try:
                message = await asyncio.wait_for(socket.recv(), self.auth_timeout)
            except TimeoutError:
                raise ProtocolError("AUTH_FAILED", "Authentication deadline exceeded") from None
            config = parse_json(message, "config")
            if self.clock() >= self._deadline:
                raise ProtocolError("AUTH_EXPIRED", "Session admission has expired")
            if self._consumed or not hmac.compare_digest(config["token"], self._token):
                raise ProtocolError("AUTH_FAILED", "Session authentication failed")
            if (config["sessionId"], config["generation"]) != (self.session_id, self.generation):
                raise ProtocolError("AUTH_FAILED", "Session authentication failed")
            if config["model"] not in ("base.en", "small"):
                raise ProtocolError("UNSUPPORTED_MODEL", "Requested model is not supported")
            # No awaits between ownership checks and claim: concurrent clients cannot both win.
            self._consumed, self._owner, owns = True, socket, True
            self.session = Session.from_config(config)
            await socket.send(encode_event(self.session.status_event()))
            if self.pipeline_factory is not None:
                async def emit(event):
                    if self.session.closed:
                        return
                    if event["type"] == "status":
                        self.session.status = event["status"]
                    await asyncio.wait_for(socket.send(encode_event(event)), 2)
                    if event["type"] == "status" and event["status"] == "error":
                        asyncio.create_task(socket.close(1011, "Engine unavailable"))
                self.pipeline = self.pipeline_factory(config, emit)
                self._boot = asyncio.create_task(self.pipeline.start())
            async for message in socket:
                if isinstance(message, bytes):
                    frame = parse_frame(message, self.session.enabled_sources)
                    if self.pipeline is None or not self.pipeline.ready or self.pipeline.paused:
                        await self._error(socket, "NOT_READY", "Transcription pipeline is not available",
                                          recoverable=True, authenticated=True)
                    else:
                        try:
                            await self.pipeline.ingest(frame)
                        except ProtocolError as error:
                            if not error.recoverable:
                                raise
                            await self._error(socket, error.code, str(error), True, True)
                    continue
                control = parse_json(message, "control")
                self.session.accept_control(control)
                if control["type"] == "stop":
                    await self._close_pipeline(flush=True)
                    self.session.close()
                    await socket.send(encode_event(self.session.status_event(control["requestId"])))
                    await socket.close(1000, "Session stopped")
                    return
                if control["type"] == "ping":
                    await socket.send(encode_event(self.session.status_event(control["requestId"])))
                elif self.pipeline is not None and self.pipeline.ready:
                    kind = control["type"]
                    if kind in ("source-start", "source-gap"):
                        await self.pipeline.anchor(control["source"], control["startSample"], control.get("droppedSamples", 0),
                                                   discontinuity=kind == "source-gap")
                        self.session.status = "listening"
                    elif kind == "source-end":
                        await self.pipeline.source_end(control["source"], control["paddedSamples"])
                    elif kind == "pause":
                        await self.pipeline.pause()
                        self.session.status = "ready"
                    elif kind == "resume":
                        await self.pipeline.resume()
                        self.session.status = "ready"
                    await socket.send(encode_event(self.session.status_event(control["requestId"])))
                else:
                    await self._error(socket, "NOT_READY", "Audio lifecycle is not available yet",
                                      recoverable=True, authenticated=True)
        except ProtocolError as error:
            if owns:
                # Revoke before the close handshake can yield to another client.
                self.session.close()
                self._token = ""
            try:
                await self._error(socket, error.code, str(error), error.recoverable, owns)
                await socket.close(1008, "Protocol rejected")
            except ConnectionClosed:
                pass
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            try:
                await self._error(socket, "SERVER_ERROR", "Local sidecar transport failed", authenticated=owns)
                await socket.close(1011, "Sidecar unavailable")
            except ConnectionClosed:
                pass
        finally:
            self._active -= 1
            if owns:
                self.session.close()
                self._owner = None
                self._token = ""
                await self._close_pipeline()
                self.finished.set()


async def run_from_environment():
    # Pop the token so future child processes cannot inherit it accidentally.
    token = os.environ.pop("VINXA_SIDECAR_TOKEN", "")
    session_id = os.environ.get("VINXA_SIDECAR_SESSION_ID", "")
    generation_text = os.environ.get("VINXA_SIDECAR_GENERATION", "")
    if not generation_text.isascii() or not generation_text.isdecimal() or len(generation_text) > 16:
        raise ProtocolError("INVALID_LAUNCH", "Invalid sidecar launch configuration")
    server = SidecarServer(token, session_id, int(generation_text))
    async with server:
        loop = asyncio.get_running_loop()
        installed = []
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                installed.append((sig, signal.getsignal(sig)))
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(server.finished.set))
            except (ValueError, OSError):
                pass
        try:
            listening = validate("listening", {"protocolVersion": 1, "port": server.port, "state": "listening"})
            print(json.dumps(listening, separators=(",", ":")), flush=True)
            await server.finished.wait()
        finally:
            for sig, handler in installed:
                signal.signal(sig, handler)


def main():
    try:
        asyncio.run(run_from_environment())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        # Never emit traceback, token, raw payloads, transcript or private paths.
        sys.stderr.write(_STARTUP_ERROR)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
