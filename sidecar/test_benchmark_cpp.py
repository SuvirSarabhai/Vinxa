from itertools import chain, repeat
import hashlib
import json
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import psutil
import pytest

from sidecar.benchmark import MemorySampler
from sidecar.benchmark_cpp import (
    benchmark_cpp,
    main,
    parse_whisper_timings,
    WhisperCppExecutionError,
    WhisperCppTimingError,
)


SAMPLE_TIMINGS_OUTPUT = """
whisper_init_from_file_with_params_no_state: loading model from 'models/ggml-base.en.bin'
whisper_model_load: loading model
system_info: n_threads = 4 / 8 | AVX = 1 | AVX2 = 1

main: processing 'tone.wav' (16000 samples, 1.0 sec), 4 threads, 1 processors, 5 beams + best of 5, lang = en, task = transcribe, timestamps = 1 ...

[00:00:00.000 --> 00:00:01.000]   CONFIDENTIAL_TRANSCRIPT_DO_NOT_LOG

whisper_print_timings:     load time =   120.50 ms
whisper_print_timings:     fallbacks =   0 p /   0 h
whisper_print_timings:      mel time =     8.20 ms
whisper_print_timings:   sample time =     2.10 ms
whisper_print_timings:   encode time =   140.00 ms
whisper_print_timings:   decode time =    45.30 ms
whisper_print_timings:    batch time =     0.00 ms
whisper_print_timings:   prompt time =     0.00 ms
whisper_print_timings:    total time =   320.50 ms
"""


def test_parse_whisper_timings_valid():
    parsed = parse_whisper_timings(SAMPLE_TIMINGS_OUTPUT)
    assert parsed["load_time_ms"] == 120.50
    assert parsed["total_time_ms"] == 320.50
    assert parsed["load_time_seconds"] == pytest.approx(0.12050)
    assert parsed["total_time_seconds"] == pytest.approx(0.32050)
    assert parsed["inference_seconds"] == pytest.approx(0.20000)
    assert parsed["inference_calculation_method"] == "total_minus_load"
    assert parsed["encode_time_ms"] == 140.00
    assert parsed["decode_time_ms"] == 45.30


@pytest.mark.parametrize("missing_output,match_msg", [
    ("all timings stripped by -np flag", "load time"),
    ("whisper_print_timings:     load time = 100.0 ms", "total time"),
    ("whisper_print_timings:    total time = 200.0 ms", "load time"),
])
def test_parse_whisper_timings_missing_fields_raises(missing_output, match_msg):
    with pytest.raises(WhisperCppTimingError, match=match_msg):
        parse_whisper_timings(missing_output)


@pytest.mark.parametrize("invalid_output,match_msg", [
    (
        "whisper_print_timings:     load time = 300.0 ms\nwhisper_print_timings:    total time = 100.0 ms",
        "less than load time",
    ),
    (
        "whisper_print_timings:     load time = -50.0 ms\nwhisper_print_timings:    total time = 100.0 ms",
        "non-negative",
    ),
])
def test_parse_whisper_timings_invalid_values_raises(invalid_output, match_msg):
    with pytest.raises(WhisperCppTimingError, match=match_msg):
        parse_whisper_timings(invalid_output)


def test_benchmark_cpp_metrics_only_and_no_transcript(tmp_path, monkeypatch, capsys):
    wav = tmp_path / "tone.wav"
    wav.write_bytes(b"dummy wav data for sha calculation")
    binary = tmp_path / "whisper-cli.exe"
    binary.write_bytes(b"dummy binary")
    model = tmp_path / "ggml-base.en.bin"
    model.write_bytes(b"dummy model")

    fake_audio = SimpleNamespace(
        duration_seconds=2.0,
        full_scale_samples=0,
        sample_rate=16000,
    )
    monkeypatch.setattr("sidecar.benchmark_cpp.read_wav", lambda _: fake_audio)

    # Mock subprocess.Popen
    mock_proc = Mock()
    mock_proc.pid = 99999
    mock_proc.returncode = 0
    mock_proc.communicate.return_value = (
        b"[00:00:00.000 --> 00:00:02.000] CONFIDENTIAL_TRANSCRIPT_DO_NOT_LOG\n",
        SAMPLE_TIMINGS_OUTPUT.encode("utf-8"),
    )
    monkeypatch.setattr("sidecar.benchmark_cpp.subprocess.Popen", lambda *args, **kwargs: mock_proc)

    # Mock MemorySampler to avoid touching real processes during unit tests
    class FakeMemorySampler:
        peak_bytes = 120 * 1024 * 1024
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass

    monkeypatch.setattr("sidecar.benchmark_cpp.MemorySampler", FakeMemorySampler)

    result = benchmark_cpp(wav, binary, model, "base.en", runs=3, threads=4)

    assert result["backend"] == "whisper.cpp"
    assert result["model_name"] == "base.en"
    assert len(result["runs"]) == 3
    assert result["inference_calculation_method"] == "total_minus_load"
    assert result["median_inference_seconds"] == pytest.approx(0.20000)
    assert result["median_rtf"] == pytest.approx(0.10000)  # 0.2 / 2.0
    assert result["median_load_time_seconds"] == pytest.approx(0.12050)
    assert result["median_total_time_seconds"] == pytest.approx(0.32050)
    assert result["median_peak_rss_mib"] == pytest.approx(120.0)
    assert result["sample_sha256"] == hashlib.sha256(b"dummy wav data for sha calculation").hexdigest()
    # Confirm transcripts are NOT stored anywhere in the result
    serialized = json.dumps(result)
    assert "CONFIDENTIAL_TRANSCRIPT_DO_NOT_LOG" not in serialized
    assert "CONFIDENTIAL_TRANSCRIPT_DO_NOT_LOG" not in capsys.readouterr().out


def test_benchmark_cpp_cli_preserves_existing_output(tmp_path):
    output = tmp_path / "existing_metrics.json"
    output.write_text("KEEP_ME", encoding="utf-8")
    ret = main([
        "--input", str(tmp_path / "any.wav"),
        "--binary", str(tmp_path / "whisper-cli.exe"),
        "--model-path", str(tmp_path / "model.bin"),
        "--model-name", "base.en",
        "--output", str(output),
    ])
    assert ret == 1
    assert output.read_text(encoding="utf-8") == "KEEP_ME"


def test_benchmark_cpp_cli_handles_subprocess_failure(tmp_path, monkeypatch):
    wav = tmp_path / "tone.wav"
    wav.write_bytes(b"dummy")
    binary = tmp_path / "whisper-cli.exe"
    binary.write_bytes(b"dummy")
    model = tmp_path / "model.bin"
    model.write_bytes(b"dummy")

    monkeypatch.setattr("sidecar.benchmark_cpp.read_wav", lambda _: SimpleNamespace(duration_seconds=1.0, full_scale_samples=0))

    mock_proc = Mock()
    mock_proc.pid = 99999
    mock_proc.returncode = 1
    mock_proc.communicate.return_value = (b"", b"Error: failed to compute")
    monkeypatch.setattr("sidecar.benchmark_cpp.subprocess.Popen", lambda *args, **kwargs: mock_proc)

    with pytest.raises(WhisperCppExecutionError, match="exit code 1"):
        benchmark_cpp(wav, binary, model, "base.en")


def test_benchmark_cpp_requires_at_least_three_runs(tmp_path):
    with pytest.raises(ValueError, match="three"):
        benchmark_cpp(tmp_path / "a.wav", tmp_path / "b", tmp_path / "m", "base.en", runs=2)


def test_benchmark_cpp_missing_binary_or_model(tmp_path):
    wav = tmp_path / "tone.wav"
    wav.write_bytes(b"dummy")
    with pytest.raises(FileNotFoundError, match="whisper-cli binary not found"):
        benchmark_cpp(wav, tmp_path / "nonexistent.exe", tmp_path / "model.bin", "base.en")

    binary = tmp_path / "whisper-cli.exe"
    binary.write_bytes(b"dummy")
    with pytest.raises(FileNotFoundError, match="GGML model not found"):
        benchmark_cpp(wav, binary, tmp_path / "nonexistent.bin", "base.en")


def test_memory_sampler_handles_exited_child_process():
    # Process that raises NoSuchProcess when memory_info is called
    mock_proc = Mock(spec=psutil.Process)
    mock_proc.memory_info.side_effect = psutil.NoSuchProcess(pid=12345)
    mock_proc.is_running.return_value = False

    sampler = MemorySampler(mock_proc)
    with sampler:
        pass
    assert sampler.peak_bytes == 0

    # Process that provides one sample, then terminates
    mock_proc2 = Mock(spec=psutil.Process)
    mock_proc2.memory_info.side_effect = chain(
        [SimpleNamespace(rss=50 * 1024 * 1024, peak_wset=60 * 1024 * 1024)],
        repeat(psutil.NoSuchProcess(pid=12346)),
    )
    mock_proc2.is_running.return_value = False

    sampler2 = MemorySampler(mock_proc2)
    with sampler2:
        pass
    assert sampler2.peak_bytes == 60 * 1024 * 1024



def test_benchmark_cpp_timeout_kills_child(tmp_path, monkeypatch):
    wav, binary, model = (tmp_path / name for name in ("input.wav", "cli.exe", "model.bin"))
    for path in (wav, binary, model):
        path.write_bytes(b"fixture")
    monkeypatch.setattr("sidecar.benchmark_cpp.read_wav", lambda _: SimpleNamespace(duration_seconds=1.0, full_scale_samples=0))
    proc = Mock(pid=99999)
    proc.communicate.side_effect = [subprocess.TimeoutExpired("cli", 600), (None, b"")]
    monkeypatch.setattr("sidecar.benchmark_cpp.subprocess.Popen", lambda *a, **k: proc)
    with pytest.raises(WhisperCppExecutionError, match="600 second"):
        benchmark_cpp(wav, binary, model, "base.en")
    proc.kill.assert_called_once()
    assert proc.communicate.call_count == 2
