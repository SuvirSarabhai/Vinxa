"""Validate the Zod-generated wire contract without duplicated Python models."""

from dataclasses import dataclass
import json
import math
import struct
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

MAX_MESSAGE_BYTES = 4096
MAX_EVENT_BYTES = 65536
_wire = json.loads(Path(__file__).with_name("wire-schema.json").read_text(encoding="utf-8"))
PCM = _wire["constants"]
SOURCE_NAMES = {value: name for name, value in PCM["sourceIds"].items()}
_validators = {}
for _name in ("config", "control", "event", "frameMetadata", "listening"):
    Draft202012Validator.check_schema(_wire[_name])
    _validators[_name] = Draft202012Validator(_wire[_name], format_checker=FormatChecker())


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str, recoverable: bool = False):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


def _finite(value, depth=0):
    if depth > 32:
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    if isinstance(value, dict):
        return all(_finite(item, depth + 1) for item in value.values())
    if isinstance(value, list):
        return all(_finite(item, depth + 1) for item in value)
    return True


def validate(kind: str, payload: object) -> dict:
    if not isinstance(payload, dict) or not _finite(payload) or not _validators[kind].is_valid(payload):
        raise ProtocolError("INVALID_" + kind.upper(), "Message does not match the protocol contract")
    # These cross-field Zod refinements cannot be represented by JSON Schema.
    if kind == "event":
        if "endMs" in payload and payload["endMs"] < payload["startMs"]:
            raise ProtocolError("INVALID_EVENT", "Transcript time range is invalid")
        if payload["type"] == "error" and (payload["sessionId"] is None) != (payload["generation"] is None):
            raise ProtocolError("INVALID_EVENT", "Error session identity is incomplete")
    return payload


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def parse_json(message: object, kind: str) -> dict:
    if not isinstance(message, str):
        raise ProtocolError("INVALID_" + kind.upper(), "Expected a JSON text message")
    try:
        if len(message.encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise ValueError("Message too large")
        payload = json.loads(message, object_pairs_hook=_unique_object)
        return validate(kind, payload)
    except (ValueError, RecursionError, UnicodeError):
        raise ProtocolError("INVALID_" + kind.upper(), "Invalid or unsupported JSON message") from None


@dataclass(frozen=True)
class AudioFrame:
    source: str
    pcm: bytes
    metadata: dict | None = None


TIMED_HEADER = struct.Struct("<2sBBIdddIdI")


def pack_timed_frame(source_id, pcm, sequence, start_sample, capture_ms, sent_ms, uncertainty_ms=0):
    if source_id not in SOURCE_NAMES or len(pcm) != 3200:
        raise ProtocolError("INVALID_FRAME", "Invalid timed audio frame")
    return TIMED_HEADER.pack(b"VX", 2, source_id, sequence, start_sample, capture_ms,
                             sent_ms, 1600, uncertainty_ms, 0) + pcm


def parse_frame(message: object, enabled_sources, protocol_version=1) -> AudioFrame:
    if protocol_version == 2:
        if not isinstance(message, bytes) or len(message) != TIMED_HEADER.size + 3200:
            raise ProtocolError("INVALID_FRAME", "Expected a timed header and 3200 PCM bytes")
        magic, version, source_id, sequence, start, capture, sent, count, uncertainty, flags = TIMED_HEADER.unpack_from(message)
        if (magic != b"VX" or version != 2 or flags not in (0, 1) or count != 1600 or
                not all(math.isfinite(v) for v in (start, capture, sent, uncertainty)) or
                start < 0 or start > 9007199254740991 or int(start) != start or uncertainty < 0):
            raise ProtocolError("INVALID_FRAME", "Invalid timed audio header")
        source = SOURCE_NAMES.get(source_id)
        if source is None or source not in enabled_sources:
            raise ProtocolError("SOURCE_DISABLED", "Audio source is unavailable")
        metadata = {"sequence": sequence, "startSample": int(start), "captureTimeMs": capture,
                    "sentMs": sent, "sampleCount": count, "captureErrorMs": uncertainty,
                    "captureKind": "render-estimate" if flags & 1 else "replay"}
        return AudioFrame(source, message[TIMED_HEADER.size:], metadata)
    if not isinstance(message, bytes) or len(message) != PCM["frameBytes"] + 1:
        raise ProtocolError("INVALID_FRAME", "Expected a source byte and exactly 3200 PCM bytes")
    source = SOURCE_NAMES.get(message[0])
    if source is None:
        raise ProtocolError("INVALID_FRAME", "Unknown audio source")
    if source not in enabled_sources:
        raise ProtocolError("SOURCE_DISABLED", "Audio source is disabled")
    return AudioFrame(source, message[1:])


def encode_event(payload: dict) -> str:
    validate("event", payload)
    encoded = json.dumps(payload, allow_nan=False, ensure_ascii=True, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_EVENT_BYTES:
        raise ProtocolError("INVALID_EVENT", "Event exceeds the output limit")
    return encoded
