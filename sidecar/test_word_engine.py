from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from sidecar.engine import SpeechEngine, SpeechEngineError


def test_word_inference_model_reuse_quality_filters_and_warmup(tmp_path, monkeypatch):
    backend = Mock()
    word = SimpleNamespace(word=" scripted", start=0.1, end=0.2)
    segment = SimpleNamespace(text="scripted", words=[word], no_speech_prob=0.1, avg_logprob=-0.1, compression_ratio=1)
    backend.transcribe.side_effect = lambda *a, **kw: (iter([segment]), SimpleNamespace())
    constructor = Mock(return_value=backend)
    monkeypatch.setattr("sidecar.engine.importlib.import_module", lambda _: SimpleNamespace(WhisperModel=constructor))
    engine = SpeechEngine(cache_dir=tmp_path / "model")
    result = engine.transcribe_samples(np.ones(16000, np.float32) * 0.1, offset=16000)
    assert result.words[0].start == 17600 and result.words[0].end == 19200
    segment.no_speech_prob = 0.99
    segment.avg_logprob = -1.1
    assert not engine.transcribe_samples(np.zeros(16000)).words
    engine.warmup()
    assert constructor.call_count == 1
    assert backend.transcribe.call_args.kwargs["condition_on_previous_text"] is False
    assert backend.transcribe.call_args.kwargs["word_timestamps"] is True


def test_streaming_retains_original_encoder_context_and_sanitizes_errors(tmp_path):
    engine = SpeechEngine(cache_dir=tmp_path / "cache")
    model = Mock()
    original = model.encode
    model.transcribe.return_value = (iter([]), SimpleNamespace())
    engine._model = model
    engine.transcribe_samples(np.zeros(16000))
    assert model.encode is original
    assert "chunk_length" not in model.transcribe.call_args.kwargs
    assert "without_timestamps" not in model.transcribe.call_args.kwargs
    model.transcribe.side_effect = RuntimeError("private-native-marker")
    with pytest.raises(SpeechEngineError, match="Local word inference failed"):
        engine.transcribe_samples(np.zeros(16000))
    assert model.encode is original


@pytest.mark.parametrize("audio", [np.empty(0), np.ones((2, 100)), np.array([np.nan]), np.array([2.0])])
def test_invalid_samples_rejected_without_loading(audio):
    with pytest.raises(SpeechEngineError):
        SpeechEngine().transcribe_samples(audio)
