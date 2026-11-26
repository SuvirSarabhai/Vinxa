# Speech Sidecar

The sidecar owns local speech recognition. Electron sends binary 16 kHz mono PCM frames over a localhost WebSocket; the sidecar returns schema-validated status, partial-transcript, final-transcript, and error events.

## Responsibilities

- Receive microphone and system-audio frames without mixing them.
- Apply voice activity detection before inference.
- Run faster-whisper incrementally and use LocalAgreement to commit stable words.
- Preserve `source`, start/end millisecond timestamps, and finality on every segment.
- Deduplicate near-identical mic/system text caused by speaker echo.
- Keep its WebSocket server bound to `127.0.0.1` and require a session token.

## Model policy

Use `base.en` int8 for the first performance baseline. Test `small` int8 for Indian-English accents and Hindi-English code-switching. Models are machine-local assets: configure their location with `VINXA_MODEL_DIR`, keep them out of Git, and record the selected model plus real-time factor in the harness report.

## Protocol outline

1. Electron opens `ws://127.0.0.1:<port>` and sends a configuration message with a one-time session token.
2. Each PCM frame is prefixed with a one-byte source id: `0x01` for microphone and `0x02` for system audio.
3. The sidecar publishes JSON events. Transcript events include `source`, `text`, `startMs`, `endMs`, and `isFinal`.
4. On loss of the sidecar, Electron shows a clear status, retains local audio, and may restart the process with bounded retries.

The actual protocol and Pydantic models will live beside `server.py` once the Hour 0 shared contracts are frozen.

