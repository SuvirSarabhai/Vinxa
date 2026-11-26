"""Repeatable whisper.cpp CPU benchmarks. Console and JSON contain metrics only."""

import argparse
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
from pathlib import Path
import platform
import re
from statistics import median
import subprocess
import sys
from time import perf_counter

import numpy as np
import psutil

from .audio_utils import AudioValidationError, read_wav, real_time_factor
from .benchmark import MemorySampler


class WhisperCppTimingError(ValueError):
    """Timing diagnostics missing, malformed, or inconsistent in whisper-cli output."""


class WhisperCppExecutionError(RuntimeError):
    """whisper-cli executable failed or returned a non-zero exit code."""


LOAD_TIME_PATTERN = re.compile(
    r"(?:whisper_print_timings:\s*)?load time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms",
    re.IGNORECASE,
)
TOTAL_TIME_PATTERN = re.compile(
    r"(?:whisper_print_timings:\s*)?total time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms",
    re.IGNORECASE,
)

OPTIONAL_TIMING_PATTERNS = [
    ("mel_time_ms", re.compile(r"(?:whisper_print_timings:\s*)?mel time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)),
    ("sample_time_ms", re.compile(r"(?:whisper_print_timings:\s*)?sample time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)),
    ("encode_time_ms", re.compile(r"(?:whisper_print_timings:\s*)?encode time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)),
    ("decode_time_ms", re.compile(r"(?:whisper_print_timings:\s*)?decode time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)),
    ("batch_time_ms", re.compile(r"(?:whisper_print_timings:\s*)?batch(?:d)? time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)),
    ("prompt_time_ms", re.compile(r"(?:whisper_print_timings:\s*)?prompt time\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)),
]


def parse_whisper_timings(output: str) -> dict[str, float | str]:
    """Parse timing fields from whisper_print_timings diagnostics.

    Inference time is reported as total time minus load time with the calculation
    method explicitly recorded. Missing or invalid timings raise WhisperCppTimingError.
    """
    load_matches = LOAD_TIME_PATTERN.findall(output)
    if not load_matches:
        raise WhisperCppTimingError("Missing load time in whisper_print_timings output")

    total_matches = TOTAL_TIME_PATTERN.findall(output)
    if not total_matches:
        raise WhisperCppTimingError("Missing total time in whisper_print_timings output")

    try:
        load_ms = float(load_matches[-1])
        total_ms = float(total_matches[-1])
    except (ValueError, TypeError) as err:
        raise WhisperCppTimingError("whisper_print_timings values must be valid floating point numbers") from err

    if not (np.isfinite(load_ms) and np.isfinite(total_ms)):
        raise WhisperCppTimingError("whisper_print_timings values must be finite numbers")
    if load_ms < 0 or total_ms < 0:
        raise WhisperCppTimingError("whisper_print_timings values must be non-negative")
    if total_ms < load_ms:
        raise WhisperCppTimingError(f"Total time ({total_ms:.2f} ms) is less than load time ({load_ms:.2f} ms)")

    inference_ms = total_ms - load_ms
    load_seconds = load_ms / 1000.0
    total_seconds = total_ms / 1000.0
    inference_seconds = inference_ms / 1000.0

    result: dict[str, float | str] = {
        "load_time_ms": load_ms,
        "total_time_ms": total_ms,
        "load_time_seconds": load_seconds,
        "total_time_seconds": total_seconds,
        "inference_seconds": inference_seconds,
        "inference_calculation_method": "total_minus_load",
    }

    for key, pattern in OPTIONAL_TIMING_PATTERNS:
        matches = pattern.findall(output)
        if matches:
            try:
                val = float(matches[-1])
                if np.isfinite(val) and val >= 0:
                    result[key] = val
                    sec_key = key.replace("_ms", "_seconds")
                    result[sec_key] = val / 1000.0
            except (ValueError, TypeError):
                pass

    return result


def benchmark_cpp(
    wav: str | Path,
    binary: str | Path,
    model_path: str | Path,
    model_name: str,
    *,
    threads: int = 4,
    runs: int = 3,
    language: str = "en",
) -> dict:
    """Run whisper-cli repeatedly and collect metrics.

    Console and JSON output contain metrics only; transcript stdout is discarded.
    """
    if runs < 3:
        raise ValueError("At least three runs are required")
    if threads < 1:
        raise ValueError("CPU thread count must be positive")

    wav_path = Path(wav).expanduser().resolve()
    binary_path = Path(binary).expanduser().resolve()
    ggml_model_path = Path(model_path).expanduser().resolve()

    if not binary_path.is_file():
        raise FileNotFoundError(f"whisper-cli binary not found: {binary_path}")
    if not ggml_model_path.is_file():
        raise FileNotFoundError(f"GGML model not found: {ggml_model_path}")

    # Validate audio adheres to 16 kHz mono 16-bit PCM WAV contract
    audio = read_wav(wav_path)

    cmd = [
        str(binary_path),
        "-m", str(ggml_model_path),
        "-f", str(wav_path),
        "-t", str(threads),
        "-bs", "5",
        "-bo", "5",
        "-l", str(language),
        "-ng",
    ]

    measurements = []
    for run in range(1, runs + 1):
        wall_start = perf_counter()
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except OSError as error:
            raise WhisperCppExecutionError(f"Failed to execute whisper-cli binary: {error}") from error

        with MemorySampler(proc.pid) as sampler:
            try:
                _, stderr_bytes = proc.communicate(timeout=600)
            except subprocess.TimeoutExpired as error:
                proc.kill()
                proc.communicate()
                raise WhisperCppExecutionError("whisper-cli exceeded the 600 second run limit") from error
        wall_seconds = perf_counter() - wall_start

        if proc.returncode != 0:
            raise WhisperCppExecutionError(f"whisper-cli failed with exit code {proc.returncode}")

        # Parse diagnostics privately; raw process output is never persisted.
        output_text = (stderr_bytes or b"").decode("utf-8", errors="replace")
        timings = parse_whisper_timings(output_text)
        inference_sec = float(timings["inference_seconds"])
        rtf = real_time_factor(inference_sec, audio.duration_seconds)

        measurements.append({
            "run": run,
            "inference_seconds": inference_sec,
            "rtf": rtf,
            "load_time_seconds": float(timings["load_time_seconds"]),
            "total_time_seconds": float(timings["total_time_seconds"]),
            "wall_time_seconds": wall_seconds,
            "peak_rss_mib": sampler.peak_bytes / (1024 ** 2),
            "inference_calculation_method": "total_minus_load",
        })

    package_versions = {}
    for pkg in ("numpy", "psutil"):
        try:
            package_versions[pkg] = version(pkg)
        except PackageNotFoundError:
            package_versions[pkg] = "unknown"

    return {
        "backend": "whisper.cpp",
        "binary": str(binary_path),
        "model_name": model_name,
        "model_path": str(ggml_model_path),
        "device": "cpu",
        "compute_type": "ggml",
        "cpu_threads": threads,
        "beam_size": 5,
        "best_of": 5,
        "vad_filter": False,
        "requested_language": language,
        "sample_sha256": hashlib.sha256(wav_path.read_bytes()).hexdigest(),
        "audio_duration_seconds": audio.duration_seconds,
        "audio_full_scale_samples": audio.full_scale_samples,
        "inference_calculation_method": "total_minus_load",
        "runs": measurements,
        "median_inference_seconds": median(item["inference_seconds"] for item in measurements),
        "median_rtf": median(item["rtf"] for item in measurements),
        "median_wall_time_seconds": median(item["wall_time_seconds"] for item in measurements),
        "median_load_time_seconds": median(item["load_time_seconds"] for item in measurements),
        "median_total_time_seconds": median(item["total_time_seconds"] for item in measurements),
        "median_peak_rss_mib": median(item["peak_rss_mib"] for item in measurements),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "logical_cpus": psutil.cpu_count(),
            "physical_cpus": psutil.cpu_count(logical=False),
            "ram_gib": psutil.virtual_memory().total / (1024 ** 3),
            "versions": package_versions,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Input WAV file (16 kHz mono signed 16-bit PCM)")
    parser.add_argument("--binary", type=Path, required=True, help="Path to whisper-cli executable")
    parser.add_argument("--model-path", type=Path, required=True, help="Path to GGML model file")
    parser.add_argument("--model-name", "--model", dest="model_name", required=True, help="Model name identifier (e.g. base.en)")
    parser.add_argument("--threads", type=int, default=4, help="CPU threads (default: 4)")
    parser.add_argument("--runs", type=int, default=3, help="Benchmark runs (default: 3, at least 3)")
    parser.add_argument("--language", default="en", help="Language code (default: en)")
    parser.add_argument("--output", type=Path, help="Metrics-only JSON output; existing files are preserved")
    args = parser.parse_args(argv)

    try:
        if args.output and args.output.exists():
            raise ValueError("Output already exists; choose a new metrics path")
        result = benchmark_cpp(
            args.input,
            args.binary,
            args.model_path,
            args.model_name,
            threads=args.threads,
            runs=args.runs,
            language=args.language,
        )
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as output:
                json.dump(result, output, indent=2, allow_nan=False)
                output.write("\n")

        print(f"Model {result['model_name']} | whisper.cpp CPU | audio {result['audio_duration_seconds']:.3f} s")
        print(f"Inference timing method: {result['inference_calculation_method']} (total time - load time)")
        print("Run   Inference s   RTF      Wall s        Load s        Peak RSS MiB")
        for run in result["runs"]:
            print(
                f"{run['run']:>3}   "
                f"{run['inference_seconds']:>11.3f}   "
                f"{run['rtf']:.4f}   "
                f"{run['wall_time_seconds']:>10.3f}   "
                f"{run['load_time_seconds']:>10.3f}   "
                f"{run['peak_rss_mib']:>12.1f}"
            )
        print(
            f"Median inference {result['median_inference_seconds']:.3f} s | "
            f"RTF {result['median_rtf']:.4f} | "
            f"Wall {result['median_wall_time_seconds']:.3f} s"
        )
        return 0
    except (WhisperCppTimingError, WhisperCppExecutionError) as error:
        print(f"Whisper.cpp error: {error}", file=sys.stderr)
    except AudioValidationError as error:
        print(f"Audio validation error: {error}", file=sys.stderr)
    except (ValueError, FileNotFoundError) as error:
        print(str(error), file=sys.stderr)
    except OSError:
        print("Benchmark file access failed; check input and output permissions", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
