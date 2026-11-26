import asyncio
import json
import wave

import numpy as np
import pytest

from harness.latency import Measurements, distribution
from harness.replay import frames, load_input, paced_send
from sidecar.local_agreement import Word
from sidecar.protocol import parse_frame


def test_wav_loading_and_source_tagged_frames_preserve_pcm(tmp_path):
    target = tmp_path / "source.wav"
    pcm = (np.sin(np.arange(1700) / 16000 * 2 * np.pi * 440) * 4000).astype("<i2").tobytes()
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(pcm)
    item = load_input("system", target, 0, 0)
    assert item.pcm == pcm and item.samples == 1700
    packets = list(frames(item.pcm, 1))
    assert len(packets) == 2
    assert all(len(packet) == 3201 and parse_frame(packet, ["system"]).source == "system" for packet in packets)
    assert b"".join(packet[1:] for packet in packets)[:len(pcm)] == pcm
    assert not any(packets[-1][201:])
    with pytest.raises(ValueError):
        load_input("system", target, 0.123, 0)


def test_real_time_schedule_interleaves_sources_and_never_sends_entire_file_at_once():
    async def run():
        now, observed = [0.0], []
        async def sleep(seconds):
            now[0] += seconds
        class Socket:
            async def send(self, data):
                observed.append((data[0], now[0]))
        measurements = Measurements({"mic": [], "system": []})
        await paced_send(Socket(), {"mic": [bytes([0])] * 3, "system": [bytes([1])] * 2},
                         measurements, clock=lambda: now[0], sleep=sleep)
        assert [source for source, _ in observed] == [0, 1, 0, 1, 0]
        assert [time for _, time in observed] == pytest.approx([0.1, 0.1, 0.2, 0.2, 0.3])
    asyncio.run(run())


def test_latency_math_matching_silence_and_metrics_only_report():
    measured = Measurements({"mic": [Word("alpha", 0, 1600), Word("beta", 1600, 3200)]}, {"mic": [(300, 500)]})
    measured.sent_frame("mic", 0, 1.0)
    measured.sent_frame("mic", 1, 1.1)
    for kind, received in (("partial", 1.3), ("final", 1.5)):
        measured.observe({"type": kind, "source": "mic", "text": "alpha beta", "startMs": 0, "endMs": 200}, received)
    report = measured.report()
    assert report["sources"]["mic"]["partial_client_receipt_latency"]["median_ms"] == pytest.approx(250)
    assert report["sources"]["mic"]["partial_client_receipt_latency"]["p95_ms"] == pytest.approx(295)
    assert report["sources"]["mic"]["final_word_coverage"] == 1
    assert "alpha" not in json.dumps(report) and "beta" not in json.dumps(report)
    measured.observe({"type": "partial", "source": "mic", "text": "scripted phantom", "startMs": 310, "endMs": 400}, 1.6)
    assert measured.report()["sources"]["mic"]["silence_false_positives"] == 1
    assert distribution([])["median_ms"] is None


def test_negative_model_alignment_estimates_are_reported_not_clamped():
    measured = Measurements({"mic": [Word("test", 0, 1600)]})
    measured.sent_frame("mic", 0, 2)
    measured.observe({"type": "partial", "source": "mic", "text": "test", "startMs": 0, "endMs": 100}, 1)
    source = measured.report()["sources"]["mic"]
    assert source["negative_estimates"] == 1
    assert source["partial_client_receipt_latency"]["count"] == 0
