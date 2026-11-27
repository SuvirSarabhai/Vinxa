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


def test_every_unmatched_revision_and_empty_final_is_logged_without_text():
    measured = Measurements({"mic": [], "system": []})
    measured.sent_frame("mic", 0, 10)
    for kind, text in (("partial", "private-test-phrase"), ("partial", "revision"), ("final", "")):
        measured.observe({"type": kind, "id": "one", "source": "mic", "text": text,
                          "startMs": 0, "endMs": 100}, 10.5)
    report = measured.report()
    assert [row["type"] for row in report["event_log"]] == ["partial", "partial", "final"]
    assert report["event_log"][-1]["empty_text"]
    assert all(row["capture_timestamp"] == "unavailable" for row in report["event_log"])
    assert report["event_log"][0]["event_end_frame_to_client_receipt_ms"] == 500
    assert "private-test-phrase" not in json.dumps(report)


def test_backpressure_duration_and_pacing_are_measured_separately():
    async def run():
        now = [0.0]
        async def sleep(seconds):
            now[0] += seconds
        class Socket:
            async def send(self, data):
                now[0] += 0.025
        measured = Measurements({"mic": []})
        await paced_send(Socket(), {"mic": [bytes(3201)] * 2}, measured,
                         clock=lambda: now[0], sleep=sleep)
        source = measured.report()["sources"]["mic"]
        assert source["samples_sent_including_padding"] == 3200
        assert source["websocket_send_duration_ms"]["median_ms"] == pytest.approx(25)
        assert measured.report()["replay_pacing_jitter_ms"]["maximum_ms"] == pytest.approx(0)
    asyncio.run(run())


def test_sidecar_timings_join_by_identity_without_subtracting_process_clocks():
    measured = Measurements({"mic": []})
    measured.observe({"type": "partial", "id": "session:0:mic:1:0", "sessionId": "session",
                      "source": "mic", "text": "private-test-phrase", "startMs": 0, "endMs": 100}, 10)
    measured.attach_sidecar_timing({"events": [
        {"source": "mic", "stage": "server_received", "sidecar_monotonic_seconds": 100},
        {"source": "mic", "stage": "inference_start", "queue_wait_ms": 20},
        {"source": "mic", "stage": "inference_complete", "worker_start": 101,
         "worker_complete": 102, "duration_ms": 1000, "start": 0, "end": 1600},
        {"source": "mic", "stage": "text_emitted", "generation": 0, "utterance": 1,
         "chunk": 0, "final": False, "sidecar_monotonic_seconds": 103}
    ]})
    row = measured.report()["event_log"][0]
    assert row["sidecar_receive_timestamp"] == 100
    assert row["transcription_start_timestamp"] == 101
    assert row["emission_timestamp"] == 103
    assert row["measured_capture_latency_ms"] == "unavailable"
    assert row["client_receive_monotonic_seconds"] == 10


def test_timed_event_measurements_use_negotiated_offset_and_keep_sources_separate():
    measured = Measurements({"mic": [], "system": []})
    measured.clock_offset_ms = 1000
    timing = {"clock": "sidecar-monotonic", "firstSequence": 2, "lastSequence": 3,
              "captureStartMs": 1000, "captureEndMs": 1010, "sentMs": 1012,
              "receivedMs": 1014, "inferenceStartMs": 1020, "inferenceEndMs": 1040,
              "emittedMs": 1050, "uncertaintyMs": 1, "finalizationStartMs": 1045}
    measured.observe({"type": "partial", "source": "mic", "text": "unmatched-private-phrase",
                      "startMs": 0, "endMs": 100, "timing": timing}, 0.1)
    measured.observe({"type": "final", "source": "system", "text": "another-private-phrase",
                      "startMs": 0, "endMs": 100, "timing": timing}, 0.12)
    report = measured.report()
    assert report["sources"]["mic"]["capture_to_partial_ms"]["median_ms"] == 90
    assert report["sources"]["mic"]["sidecar_receive_to_partial_ms"]["median_ms"] == 86
    assert report["sources"]["system"]["capture_to_final_ms"]["median_ms"] == 110
    assert report["sources"]["mic"]["sidecar_processing_ms"]["median_ms"] == 20
    assert report["event_log"][0]["finalization_duration_ms"] == 5
    assert report["sources"]["mic"]["capture_to_final_ms"]["count"] == 0
    assert "unmatched-private-phrase" not in json.dumps(report)


def test_negative_capture_latency_is_preserved_and_flagged():
    measured = Measurements({"mic": []})
    measured.clock_offset_ms = 0
    timing = dict(clock='sidecar-monotonic', firstSequence=0, lastSequence=0,
                  captureStartMs=100, captureEndMs=200, sentMs=210, receivedMs=220,
                  inferenceStartMs=230, inferenceEndMs=240, emittedMs=250, uncertaintyMs=1)
    measured.observe(dict(type='partial', source='mic', text='private-test-phrase',
                          startMs=0, endMs=100, timing=timing), 0.1)
    report = measured.report()
    assert report['event_log'][0]['measured_capture_latency_ms'] == -100
    assert report['sources']['mic']['negative_capture_estimates'] == 1
