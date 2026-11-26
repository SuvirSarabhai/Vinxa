"""Replay independent WAVs over the real authenticated sidecar at 100 ms pace."""

import argparse
import asyncio
from dataclasses import dataclass
import hashlib
from importlib.metadata import version
import json
import logging
import multiprocessing as mp
import os
from pathlib import Path
import platform
import secrets
import subprocess
import sys
from time import monotonic
import uuid

import numpy as np
import psutil
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from harness.latency import Measurements
from sidecar.audio_utils import read_wav
from sidecar.local_agreement import Word
from sidecar.protocol import validate

_logger = logging.Logger("vinxa.harness.socket")
_logger.addHandler(logging.NullHandler())
_logger.propagate = False


@dataclass(frozen=True)
class Input:
    source: str
    pcm: bytes
    samples: int
    sha256: str


def load_input(source, path, leading=2.0, trailing=2.0):
    audio = read_wav(path)
    if audio.full_scale_samples:
        raise ValueError("Input fails the strict full-scale sample criterion")
    if not all(0 <= seconds <= 10 and abs(seconds * 10 - round(seconds * 10)) < 1e-8 for seconds in (leading, trailing)):
        raise ValueError("Silence padding must be 0..10 seconds in 100 ms steps")
    raw = np.rint(audio.samples * 32768).astype("<i2").tobytes()
    return Input(source, bytes(round(leading * 16000) * 2) + raw + bytes(round(trailing * 16000) * 2),
                 len(audio.samples), hashlib.sha256(Path(path).read_bytes()).hexdigest())


def frames(pcm, identity):
    if len(pcm) % 2 or identity not in (0, 1):
        raise ValueError("Invalid frame input")
    for start in range(0, len(pcm), 3200):
        chunk = pcm[start:start + 3200]
        yield bytes([identity]) + chunk + bytes(3200 - len(chunk))


def _align(paths, model, language, sender):
    try:
        from sidecar.engine import SpeechEngine
        engine = SpeechEngine(model, local_files_only=True)
        reference = {}
        for source, path in paths.items():
            audio = read_wav(path)
            words = []
            for start in range(0, len(audio.samples), 480000):
                result = engine.transcribe_samples(audio.samples[start:start + 480000], language=language,
                                                   beam_size=5, offset=start)
                words.extend(result.words)
            reference[source] = words
        sender.send({"reference": reference})  # private in-memory IPC; never stdout or a file
    except Exception:
        sender.send({"error": "Offline word alignment failed"})
    finally:
        sender.close()


def model_alignment(paths, model, language):
    receiver, sender = mp.get_context("spawn").Pipe(duplex=False)
    process = mp.get_context("spawn").Process(target=_align, args=(paths, model, language, sender))
    process.start()
    sender.close()
    try:
        if not receiver.poll(120):
            raise RuntimeError("Offline alignment timed out")
        result = receiver.recv()
        process.join(10)  # the reference model must be gone before starting the live model
        if process.exitcode != 0 or "reference" not in result:
            raise RuntimeError("Offline word alignment failed")
        return result["reference"]
    finally:
        receiver.close()
        if process.is_alive():
            if os.name == "nt":
                subprocess.run([os.path.join(os.environ["SystemRoot"], "System32", "taskkill.exe"),
                                "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            else:
                process.terminate()
            process.join(5)


async def paced_send(socket, packets, measurements, clock=monotonic, sleep=asyncio.sleep):
    start = clock()
    lag = []
    for index in range(max(len(items) for items in packets.values())):
        due = start + (index + 1) * 0.1
        await sleep(max(0, due - clock()))
        lag.append(max(0, (clock() - due) * 1000))
        if lag[-1] > 500:
            raise RuntimeError("Replay could not maintain real-time pacing")
        for source, items in packets.items():
            if index < len(items):
                await socket.send(items[index])
                measurements.sent_frame(source, index, clock())
    return lag


async def replay(inputs, references, *, model="base.en", language="en", leading=2, trailing=2):
    session_id, token = str(uuid.uuid4()), secrets.token_hex(32)
    environment = {**os.environ, "VINXA_SIDECAR_TOKEN": token, "VINXA_SIDECAR_SESSION_ID": session_id,
                   "VINXA_SIDECAR_GENERATION": "0"}
    python = sys.executable
    if os.name == "nt":
        python = sys._base_executable
        environment["PYTHONPATH"] = str(Path(sys.prefix) / "Lib" / "site-packages")
        environment["PYTHONNOUSERSITE"] = "1"
    process = await asyncio.create_subprocess_exec(python, "-m", "sidecar.server",
        cwd=Path(__file__).resolve().parents[1], env=environment,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    async def drain_stderr():
        count = 0
        while chunk := await process.stderr.read(4096):
            count += len(chunk)
        return count
    stderr_task = asyncio.create_task(drain_stderr())
    measured = Measurements(references, {item.source: [(0, leading * 1000),
        ((leading + item.samples / 16000) * 1000, (leading + item.samples / 16000 + trailing) * 1000)] for item in inputs})
    reader = None
    try:
        handshake = validate("listening", json.loads(await asyncio.wait_for(process.stdout.readline(), 15)))
        async with connect(f"ws://127.0.0.1:{handshake['port']}", proxy=None, logger=_logger,
                           max_size=65536, max_queue=16, compression=None) as socket:
            await socket.send(json.dumps({"type": "config", "protocolVersion": 1, "sessionId": session_id, "generation": 0,
                "token": token, "sampleRate": 16000, "channels": 1, "encoding": "pcm_s16le", "frameMs": 100,
                "model": model, "language": language, "enabledSources": [item.source for item in inputs]}))
            ready, stopped = asyncio.Event(), asyncio.Event()
            acknowledgements = {}
            async def receive():
                try:
                    async for message in socket:
                        event = validate("event", json.loads(message))
                        if event["sessionId"] != session_id or event["generation"] != 0:
                            raise RuntimeError("Unexpected replay session")
                        measured.observe(event, monotonic())
                        if event.get("status") == "ready":
                            ready.set()
                        if event.get("status") == "stopped":
                            stopped.set()
                        if event.get("requestId") in acknowledgements:
                            acknowledgements[event["requestId"]].set()
                        if event["type"] == "error" and not event["recoverable"]:
                            raise RuntimeError("Replay sidecar failed")
                except ConnectionClosed:
                    if not stopped.is_set():
                        raise RuntimeError("Replay socket disconnected") from None
            reader = asyncio.create_task(receive())

            async def control(kind, **fields):
                request_id = str(uuid.uuid4())
                acknowledgement = acknowledgements[request_id] = asyncio.Event()
                await socket.send(json.dumps({"type": kind, "sessionId": session_id, "generation": 0,
                                               "requestId": request_id, **fields}))
                try:
                    await asyncio.wait_for(acknowledgement.wait(), 40)
                finally:
                    acknowledgements.pop(request_id, None)

            async def wait_ready():
                waiter = asyncio.create_task(ready.wait())
                try:
                    done, _ = await asyncio.wait([waiter, reader], timeout=60, return_when=asyncio.FIRST_COMPLETED)
                    if reader in done:
                        await reader
                        raise RuntimeError("Sidecar closed before readiness")
                    if waiter not in done:
                        raise RuntimeError("Sidecar model readiness timed out")
                finally:
                    waiter.cancel()
            await wait_ready()
            for item in inputs:
                await control("source-start", source=item.source, startSample=0)
            packets = {item.source: list(frames(item.pcm, 0 if item.source == "mic" else 1)) for item in inputs}
            started = monotonic()
            lag = await paced_send(socket, packets, measured)
            for item in inputs:
                padding = (-len(item.pcm) // 2) % 1600
                await control("source-end", source=item.source, paddedSamples=padding)
            await control("stop")
            elapsed = monotonic() - started
            await asyncio.wait_for(reader, 5)
        await asyncio.wait_for(process.wait(), 10)
        if process.returncode != 0:
            raise RuntimeError("Replay process failed")
        extra_stdout = await process.stdout.read()
        stderr = await stderr_task
        if extra_stdout:
            raise RuntimeError("Unexpected sidecar stdout")
        result = measured.report()
        return {"status": "DONE", "latency_kind": "client-receipt (server emission time unavailable; contract unchanged)",
            "alignment_kind": "offline model-aligned estimates, not human ground truth", "elapsed_seconds": elapsed,
            "replay_maximum_lag_ms": max(lag), "child_exit_code": process.returncode,
            "child_stderr_bytes": stderr, "leading_silence_seconds": leading, "trailing_silence_seconds": trailing,
            "inputs": {item.source: {"sha256": item.sha256, "samples": item.samples, "duration_seconds": item.samples / 16000}
                       for item in inputs}, **result}
    finally:
        if reader and not reader.done():
            reader.cancel()
        if reader:
            await asyncio.gather(reader, return_exceptions=True)
        if process.returncode is None:
            process.kill()
            await process.communicate()
        if not stderr_task.done():
            stderr_task.cancel()
        await asyncio.gather(stderr_task, return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mic", type=Path)
    parser.add_argument("--system", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--model", choices=("base.en", "small"), default="base.en")
    parser.add_argument("--language", default="en")
    parser.add_argument("--reference", type=Path, help="Private word-aligned JSON; omitted uses an isolated offline alignment process")
    args = parser.parse_args()
    try:
        if args.report.exists():
            raise ValueError("Report already exists")
        paths = {source: path for source, path in (("mic", args.mic), ("system", args.system)) if path}
        if not paths:
            raise ValueError("Provide at least one WAV")
        inputs = [load_input(source, path) for source, path in paths.items()]
        if args.reference:
            raw = json.loads(args.reference.read_text(encoding="utf-8"))
            references = {source: [Word(w["text"], w["startSample"], w["endSample"]) for w in raw[source]] for source in paths}
        else:
            references = model_alignment(paths, args.model, args.language)
        # Inputs contain two seconds of known silence before the original WAV.
        references = {source: [Word(w.text, w.start + 32000, w.end + 32000) for w in words] for source, words in references.items()}
        result = asyncio.run(replay(inputs, references, model=args.model, language=args.language))
        if args.reference:
            result["alignment_kind"] = "user-supplied reference; alignment quality depends on its annotations"
        result["environment"] = {"python": platform.python_version(), "processor": platform.processor(),
            "logical_cpus": psutil.cpu_count(), "physical_cpus": psutil.cpu_count(logical=False),
            "ram_gib": psutil.virtual_memory().total / 1024 ** 3,
            "versions": {name: version(name) for name in ("faster-whisper", "ctranslate2", "onnxruntime", "websockets")}}
        result["configuration"] = {"model": args.model, "language": args.language, "cpu_threads": int(os.environ.get("VINXA_CPU_THREADS", "4")),
            "beam_size": int(os.environ.get("VINXA_BEAM_SIZE", "1")), "interval_seconds": float(os.environ.get("VINXA_STREAM_INTERVAL_SECONDS", "1")),
            "window_seconds": float(os.environ.get("VINXA_STREAM_WINDOW_SECONDS", "6"))}
        with args.report.open("x", encoding="utf-8") as output:
            json.dump(result, output, indent=2, allow_nan=False)
            output.write("\n")
        print(json.dumps({"status": "DONE", "sources": list(paths), "reported_dropped_samples": result["reported_dropped_samples"]}))
        return 0
    except Exception:
        print("Replay failed; verify the local runtime, valid WAVs and a new report destination.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
