"""Repeatable CPU benchmarks. Console and JSON contain metrics only."""

import argparse
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import platform
from statistics import median
import sys
from threading import Event, Thread

import psutil

from .audio_utils import AudioValidationError, read_wav
from .engine import SpeechEngine, SpeechEngineError


class MemorySampler:
    """Sample process RSS at 50 ms intervals safely even after process exit."""

    def __init__(self, process: psutil.Process | int | None = None):
        self.peak_bytes = 0
        self._stop = Event()
        if process is None:
            self._process: psutil.Process | None = psutil.Process()
        elif isinstance(process, int):
            try:
                self._process = psutil.Process(process)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                self._process = None
        else:
            self._process = process
        self._thread = Thread(target=self._sample, daemon=True)

    def _get_rss(self) -> int:
        if self._process is None:
            return 0
        try:
            mem = self._process.memory_info()
            rss = int(mem.rss)
            peak_wset = int(getattr(mem, "peak_wset", 0))
            return max(rss, peak_wset)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return 0

    def _sample(self):
        while not self._stop.is_set():
            rss = self._get_rss()
            if rss > self.peak_bytes:
                self.peak_bytes = rss
            if self._process is not None:
                try:
                    if not self._process.is_running():
                        break
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    break
            self._stop.wait(0.05)

    def __enter__(self):
        self.peak_bytes = self._get_rss()
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join()
        rss = self._get_rss()
        if rss > self.peak_bytes:
            self.peak_bytes = rss


def benchmark(wav: Path | str, model: str, *, runs: int = 3, language: str | None = None,
              threads: int = 4, reference: Path | str | None = None, offline: bool = False,
              cache_dir: Path | None = None) -> dict:
    if runs < 3:
        raise ValueError("At least three runs are required")
    wav_path = Path(wav)
    audio = read_wav(wav_path)
    ref_path = Path(reference) if reference else None
    reference_text = ref_path.read_text(encoding="utf-8") if ref_path else None
    if reference_text is not None and not reference_text.strip():
        raise ValueError("Reference transcript is empty")
    engine = SpeechEngine(model, cpu_threads=threads, cache_dir=cache_dir, local_files_only=offline)
    with MemorySampler() as loading:
        engine.load()
    measurements = []
    for run in range(1, runs + 1):
        with MemorySampler() as memory:
            result = engine.transcribe(wav_path, language=language)
        error_rate = None
        if reference_text is not None:
            from jiwer import wer
            error_rate = float(wer(reference_text, result.text))
        measurements.append({
            "run": run, "inference_seconds": result.inference_seconds, "rtf": result.rtf,
            "peak_rss_mib": memory.peak_bytes / 1024**2, "wer": error_rate,
            "language": result.language, "language_probability": result.language_probability,
            "segments": len(result.segments), "nonempty_transcript": bool(result.text.strip()),
        })
    return {
        "backend": "faster-whisper", "model": model, "device": "cpu", "compute_type": "int8",
        "cpu_threads": threads, "beam_size": 5, "vad_filter": False,
        "condition_on_previous_text": False, "requested_language": language,
        "sample_sha256": hashlib.sha256(wav_path.read_bytes()).hexdigest(),
        "audio_duration_seconds": audio.duration_seconds, "audio_full_scale_samples": audio.full_scale_samples,
        "model_load_seconds": engine.model_load_seconds, "model_load_peak_rss_mib": loading.peak_bytes / 1024**2,
        "runs": measurements,
        "median_inference_seconds": median(item["inference_seconds"] for item in measurements),
        "median_rtf": median(item["rtf"] for item in measurements),
        "median_peak_rss_mib": median(item["peak_rss_mib"] for item in measurements),
        "environment": {
            "python": platform.python_version(), "platform": platform.platform(),
            "logical_cpus": psutil.cpu_count(), "physical_cpus": psutil.cpu_count(logical=False),
            "ram_gib": psutil.virtual_memory().total / 1024**3,
            "versions": {name: version(name) for name in ("faster-whisper", "ctranslate2", "numpy", "psutil")},
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--model", choices=("base.en", "small"), required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language")
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--output", type=Path, help="Metrics-only JSON; existing files are preserved")
    args = parser.parse_args(argv)
    try:
        if args.output and args.output.exists():
            raise ValueError("Output already exists; choose a new metrics path")
        result = benchmark(args.input, args.model, runs=args.runs, language=args.language, threads=args.threads,
                           reference=args.reference, offline=args.offline, cache_dir=args.cache_dir)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as output:
                json.dump(result, output, indent=2, allow_nan=False)
                output.write("\n")
        print(f"Model {args.model} | CPU INT8 | audio {result['audio_duration_seconds']:.3f} s")
        print(f"Model load {result['model_load_seconds']:.3f} s")
        print("Run   Inference s   RTF      Peak RSS MiB   WER")
        for run in result["runs"]:
            wer_text = "PENDING" if run["wer"] is None else f"{run['wer']:.4f}"
            print(f"{run['run']:>3}   {run['inference_seconds']:>11.3f}   {run['rtf']:.4f}   {run['peak_rss_mib']:>12.1f}   {wer_text}")
        print(f"Median {result['median_inference_seconds']:.3f} s | RTF {result['median_rtf']:.4f}")
        return 0
    except SpeechEngineError as error:
        print(f"{error.code}: {error}", file=sys.stderr)
    except (AudioValidationError, ValueError) as error:
        print(str(error), file=sys.stderr)
    except OSError:
        print("Benchmark file access failed; check input, reference and output permissions", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
