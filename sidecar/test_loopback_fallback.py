from types import SimpleNamespace
import wave

import numpy as np
import pytest

from sidecar.loopback_fallback import LoopbackError, capture, encode_pcm, select_loopback


DEVICE = {"index": 16, "name": "Selected [Loopback]", "isLoopbackDevice": True,
          "defaultSampleRate": 48000, "maxInputChannels": 2}
BACKEND = SimpleNamespace(paFloat32=1, paContinue=0, paComplete=1, paAbort=2)


class FakeAudio:
    def __init__(self, status=0, fail=False):
        self.status, self.fail, self.closed = status, fail, False

    def get_loopback_device_info_generator(self):
        return iter([DEVICE])

    def open(self, **kwargs):
        if self.fail:
            raise OSError("endpoint unavailable")
        assert kwargs["input_device_index"] == 16
        assert kwargs["channels"] == 2 and kwargs["rate"] == 48000
        owner = self

        class Stream:
            def __enter__(self):
                tone = 0.2 * np.sin(2 * np.pi * 1000 * np.arange(48000) / 48000)
                data = np.repeat(tone[:, None], 2, axis=1).astype("<f4").tobytes()
                kwargs["stream_callback"](data, 48000, {}, owner.status)
                return self

            def __exit__(self, *args):
                owner.closed = True

        return Stream()


def test_selection_rejects_mic_missing_and_ambiguous_endpoints():
    assert select_loopback([DEVICE], DEVICE["name"]) == DEVICE
    for devices in ([], [dict(DEVICE, isLoopbackDevice=False)], [DEVICE, DEVICE]):
        with pytest.raises(LoopbackError, match="exactly one"):
            select_loopback(devices, DEVICE["name"])


@pytest.mark.parametrize("rate", [44100, 48000, 16000])
def test_resampling_preserves_duration_tone_and_unity_gain(rate):
    tone = 0.2 * np.sin(2 * np.pi * 1000 * np.arange(rate) / rate)
    native = np.repeat(tone[:, None], 2, axis=1).astype("<f4").tobytes()
    pcm = np.frombuffer(encode_pcm(native, rate, 2), dtype="<i2") / 32768
    assert len(pcm) == 16000
    assert np.sqrt(np.mean(pcm[100:-100] ** 2)) == pytest.approx(0.2 / np.sqrt(2), rel=0.01)
    assert np.argmax(abs(np.fft.rfft(pcm))) == 1000


def test_channel_downmix_and_bounds():
    opposite = np.array([[0.5, -0.5]] * 100, dtype="<f4").tobytes()
    assert not np.any(np.frombuffer(encode_pcm(opposite, 16000, 2), dtype="<i2"))
    values = np.array([-2, 2], dtype="<f4").tobytes()
    assert np.frombuffer(encode_pcm(values, 16000, 1), dtype="<i2").tolist() == [-32768, 32767]
    for native in (b"bad", np.array([np.nan], dtype="<f4").tobytes()):
        with pytest.raises(LoopbackError):
            encode_pcm(native, 16000, 1)


def test_capture_selected_output_contract_and_cleanup(tmp_path):
    pa, target = FakeAudio(), tmp_path / "system_audio.wav"
    result = capture(pa, BACKEND, DEVICE["name"], target, 1)
    assert pa.closed
    assert result["source"] == 1
    assert result["samples"] == 16000 and result["full_scale_samples"] == 0
    with wave.open(str(target)) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        assert len(wav.readframes(16000)) == 32000
    before = target.read_bytes()
    with pytest.raises(FileExistsError):
        capture(pa, BACKEND, DEVICE["name"], target, 1)
    assert target.read_bytes() == before


def test_overflow_is_explicit_and_finalizes_header(tmp_path):
    pa, target = FakeAudio(status=2), tmp_path / "overflow.wav"
    with pytest.raises(LoopbackError, match="overflow"):
        capture(pa, BACKEND, DEVICE["name"], target, 1)
    assert pa.closed
    with wave.open(str(target)) as wav:
        assert wav.getnframes() == 0


def test_unavailable_endpoint_finalizes_header(tmp_path):
    target = tmp_path / "unavailable.wav"
    with pytest.raises(OSError, match="unavailable"):
        capture(FakeAudio(fail=True), BACKEND, DEVICE["name"], target, 1)
    with wave.open(str(target)) as wav:
        assert wav.getnframes() == 0


@pytest.mark.parametrize("seconds", [0, 31, float("nan")])
def test_invalid_duration_never_creates_recording(tmp_path, seconds):
    target = tmp_path / "invalid.wav"
    with pytest.raises(LoopbackError, match="Duration"):
        capture(FakeAudio(), BACKEND, DEVICE["name"], target, seconds)
    assert not target.exists()
