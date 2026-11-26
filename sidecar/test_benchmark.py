from types import SimpleNamespace

import pytest

from sidecar.benchmark import benchmark, main


def test_benchmark_model_reuse_medians_and_no_content(tmp_path, monkeypatch, capsys):
    wav = tmp_path / "sample.wav"
    wav.write_bytes(b"fixture audio")
    monkeypatch.setattr("sidecar.benchmark.read_wav", lambda _: SimpleNamespace(duration_seconds=10, full_scale_samples=0))
    elapsed = iter([3.0, 1.0, 2.0])
    class Engine:
        model_load_seconds = 0.5
        def __init__(self, *a, **k): self.calls = 0
        def load(self): pass
        def transcribe(self, *a, **k):
            seconds = next(elapsed)
            return SimpleNamespace(text="private text", inference_seconds=seconds, rtf=seconds / 10,
                                   language="en", language_probability=1, segments=[object()])
    monkeypatch.setattr("sidecar.benchmark.SpeechEngine", Engine)
    monkeypatch.setattr("sidecar.benchmark.version", lambda _: "test")
    result = benchmark(wav, "base.en")
    assert result["median_inference_seconds"] == 2
    assert result["median_rtf"] == 0.2
    assert [row["run"] for row in result["runs"]] == [1, 2, 3]
    assert all(row["wer"] is None for row in result["runs"])
    assert "private text" not in str(result)
    assert "private text" not in capsys.readouterr().out


def test_cli_preserves_existing_output(tmp_path):
    output = tmp_path / "metrics.json"
    output.write_text("keep")
    assert main(["--input", str(tmp_path / "audio.wav"), "--model", "small", "--output", str(output)]) == 1
    assert output.read_text() == "keep"


def test_benchmark_requires_three_runs():
    with pytest.raises(ValueError, match="three"):
        benchmark(None, "base.en", runs=2)
