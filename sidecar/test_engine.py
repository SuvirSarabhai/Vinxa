from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import wave

import numpy as np
import pytest

from sidecar.audio_utils import AudioValidationError, read_wav, real_time_factor
from sidecar.engine import SpeechEngine, SpeechEngineError


@pytest.fixture
def wav(tmp_path):
    path = tmp_path / "tone.wav"
    pcm = (np.sin(2 * np.pi * 1000 * np.arange(16000) / 16000) * 8000).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(pcm.tobytes())
    return path


def test_wav_duration_and_pcm(wav):
    audio = read_wav(wav)
    assert audio.duration_seconds == 1
    assert audio.samples.dtype == np.float32
    assert len(audio.samples) == 16000
    assert audio.full_scale_samples == 0


def test_missing_corrupt_and_truncated_wav(tmp_path, wav):
    with pytest.raises(AudioValidationError, match="does not exist"):
        read_wav(tmp_path / "missing.wav")
    corrupt = tmp_path / "corrupt.wav"
    corrupt.write_bytes(b"invalid")
    with pytest.raises(AudioValidationError, match="valid"):
        read_wav(corrupt)
    data = wav.read_bytes()
    wav.write_bytes(data[:-2])
    with pytest.raises(AudioValidationError, match="truncated"):
        read_wav(wav)


@pytest.mark.parametrize("rate,channels,width", [(48000, 1, 2), (16000, 2, 2), (16000, 1, 1)])
def test_unsupported_wav_format(tmp_path, rate, channels, width):
    path = tmp_path / "unsupported.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(width)
        output.setframerate(rate)
        output.writeframes(bytes(100 * channels * width))
    with pytest.raises(AudioValidationError, match="16000"):
        read_wav(path)


@pytest.mark.parametrize("length", [0, 16000])
def test_empty_and_silent_wav(tmp_path, length):
    path = tmp_path / "silent.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(bytes(length * 2))
    with pytest.raises(AudioValidationError):
        read_wav(path)


def test_rtf_math_and_invalid_times():
    assert real_time_factor(2, 10) == 0.2
    for elapsed, duration in [(-1, 2), (1, 0), (1, float("nan")), (float("inf"), 2)]:
        with pytest.raises(ValueError):
            real_time_factor(elapsed, duration)


@pytest.mark.parametrize("probability", [1.0, None])
def test_model_reused_and_generator_consumed(wav, tmp_path, monkeypatch, probability):
    backend = Mock()
    def transcribe(*args, **kwargs):
        return iter([SimpleNamespace(text=" fixture ", start=0.1, end=0.5)]), SimpleNamespace(language="en", language_probability=probability)
    backend.transcribe.side_effect = transcribe
    constructor = Mock(return_value=backend)
    monkeypatch.setattr("sidecar.engine.importlib.import_module", lambda _: SimpleNamespace(WhisperModel=constructor))
    engine = SpeechEngine(cache_dir=tmp_path / "cache")
    first = engine.transcribe(wav)
    second = engine.transcribe(wav)
    assert first.language_probability == probability
    assert constructor.call_count == 1
    assert backend.transcribe.call_count == 2
    assert first.text == second.text == "fixture"
    assert first.segments[0].start_ms == 100
    assert first.segments[0].end_ms == 500
    assert first.rtf == first.inference_seconds / first.audio_duration_seconds


def test_model_missing_low_disk_and_load_failures(tmp_path, monkeypatch):
    with pytest.raises(SpeechEngineError, match="missing"):
        SpeechEngine(cache_dir=tmp_path / "cache", model_path=tmp_path / "missing").load()
    monkeypatch.setattr("sidecar.engine.shutil.disk_usage", lambda _: SimpleNamespace(free=1))
    with pytest.raises(SpeechEngineError, match="space"):
        SpeechEngine(cache_dir=tmp_path / "cache").load()
    monkeypatch.setattr("sidecar.engine.shutil.disk_usage", lambda _: SimpleNamespace(free=10**10))
    constructor = Mock(side_effect=RuntimeError("corrupt model"))
    monkeypatch.setattr("sidecar.engine.importlib.import_module", lambda _: SimpleNamespace(WhisperModel=constructor))
    with pytest.raises(SpeechEngineError) as error:
        SpeechEngine(cache_dir=tmp_path / "cache", local_files_only=True).load()
    assert error.value.code == "MODEL_UNAVAILABLE"


def test_inference_failure_is_sanitized(tmp_path, wav, monkeypatch):
    model = Mock()
    model.transcribe.side_effect = RuntimeError("private backend payload")
    monkeypatch.setattr("sidecar.engine.importlib.import_module", lambda _: SimpleNamespace(WhisperModel=lambda *a, **k: model))
    with pytest.raises(SpeechEngineError) as error:
        SpeechEngine(cache_dir=tmp_path / "cache").transcribe(wav)
    assert error.value.code == "INFERENCE_FAILED"
    assert "private" not in str(error.value)


def test_repository_cache_is_rejected():
    with pytest.raises(SpeechEngineError, match="outside"):
        SpeechEngine(cache_dir=Path(__file__).resolve().parent / "models")
