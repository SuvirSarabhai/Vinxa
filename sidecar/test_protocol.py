import copy
import json
from pathlib import Path
import secrets

import pytest

from sidecar.protocol import ProtocolError, encode_event, parse_frame, parse_json, validate

FIXTURES = json.loads(Path(__file__).with_name("fixtures").joinpath("protocol.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["name"])
def test_shared_wire_fixtures(case):
    payload = copy.deepcopy(FIXTURES["bases"][case["base"]])
    payload.update(case.get("patch", {}))
    if payload.get("token") == "$TEST_TOKEN":
        payload["token"] = secrets.token_hex(32)
    if payload.get("token") == "$TEST_TOKEN_WITH_NEWLINE":
        payload["token"] = secrets.token_hex(32) + "\n"
    for key in case.get("omit", []):
        payload.pop(key, None)
    if case["valid"]:
        assert validate(case["kind"], payload) == payload
    else:
        with pytest.raises(ProtocolError):
            validate(case["kind"], payload)


@pytest.mark.parametrize("source,identity", [("mic", 0), ("system", 1)])
def test_frame_identity_and_pcm_preserved(source, identity):
    pcm = bytes(range(256)) * 12 + bytes(128)
    result = parse_frame(bytes([identity]) + pcm, [source])
    assert result.source == source and result.pcm == pcm


@pytest.mark.parametrize("data", [b"", b"\0", bytes(3200), bytes(3202), b"\2" + bytes(3200), "text"])
def test_invalid_frames(data):
    with pytest.raises(ProtocolError, match="source|Source") as error:
        parse_frame(data, ["mic", "system"])
    assert error.value.code == "INVALID_FRAME"


def test_disabled_source():
    with pytest.raises(ProtocolError) as error:
        parse_frame(b"\1" + bytes(3200), ["mic"])
    assert error.value.code == "SOURCE_DISABLED"


@pytest.mark.parametrize("message", ["", "[", "[]", "null", '{"a":1,"a":2}',
                                       '{"a":NaN}', '{"a":1e999}', '"' + "x" * 5000 + '"',
                                       "[" * 2000 + "]" * 2000, b"binary"])
def test_malformed_json_sanitized(message):
    with pytest.raises(ProtocolError) as error:
        parse_json(message, "config")
    assert error.value.code == "INVALID_CONFIG"
    assert str(error.value) in ("Invalid or unsupported JSON message", "Expected a JSON text message")


def test_outgoing_event_validation_and_nonfinite_values():
    event = copy.deepcopy(FIXTURES["bases"]["status"])
    assert json.loads(encode_event(event)) == event
    event["metrics"] = {"source": "mic", "queueDepth": 0, "droppedSamples": 0, "inferenceMs": float("inf")}
    with pytest.raises(ProtocolError):
        encode_event(event)
