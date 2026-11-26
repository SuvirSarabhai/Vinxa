"""Reusable faster-whisper WAV engine. This module does not capture audio."""

from dataclasses import dataclass
import importlib
import os
from pathlib import Path
import shutil
from threading import Lock
from time import perf_counter

from .audio_utils import read_wav, real_time_factor


class SpeechEngineError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Segment:
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Transcription:
    text: str
    segments: list[Segment]
    language: str
    language_probability: float | None
    audio_duration_seconds: float
    model_load_seconds: float
    inference_seconds: float
    rtf: float


def model_cache(path: str | Path | None = None) -> Path:
    configured = path or os.environ.get("VINXA_MODEL_DIR")
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache"))
    target = Path(configured) if configured else base / "Vinxa" / "models"
    target = target.expanduser().resolve()
    repository = Path(__file__).resolve().parents[1]
    if target == repository or repository in target.parents:
        raise SpeechEngineError("INVALID_CACHE", "Model cache must be outside the repository")
    return target


class SpeechEngine:
    def __init__(self, model: str = "base.en", *, device: str = "cpu", compute_type: str = "int8",
                 cache_dir: str | Path | None = None, cpu_threads: int = 4,
                 local_files_only: bool = False, model_path: str | Path | None = None):
        if model not in ("base.en", "small"):
            raise ValueError("Supported models are base.en and small")
        if cpu_threads < 1:
            raise ValueError("CPU thread count must be positive")
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.cache_dir = model_cache(cache_dir)
        self.cpu_threads = cpu_threads
        self.local_files_only = local_files_only
        self.model_path = Path(model_path).expanduser() if model_path else None
        self.model_load_seconds = 0.0
        self._model = None
        self._lock = Lock()

    def load(self) -> None:
        with self._lock:
            self._load()

    def _load(self) -> None:
        if self._model is not None:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise SpeechEngineError("CACHE_UNAVAILABLE", "Cannot create or access the model cache") from error
        if self.model_path is not None:
            if not self.model_path.is_dir() or not (self.model_path / "model.bin").is_file():
                raise SpeechEngineError("MODEL_MISSING", "Local model directory or model.bin is missing")
            identifier = str(self.model_path)
        else:
            identifier = self.model_name
            cached = self.cache_dir / f"models--Systran--faster-whisper-{self.model_name}" / "snapshots"
            if not self.local_files_only and not cached.exists():
                estimated_bytes = (200 if self.model_name == "base.en" else 600) * 1024 * 1024
                try:
                    free_space = shutil.disk_usage(self.cache_dir).free
                except OSError as error:
                    raise SpeechEngineError("CACHE_UNAVAILABLE", "Cannot check free space on model cache disk") from error
                if free_space < estimated_bytes:
                    raise SpeechEngineError("DISK_SPACE", "Insufficient free space for the first model download")
        started = perf_counter()
        try:
            whisper = importlib.import_module("faster_whisper")
            self._model = whisper.WhisperModel(identifier, device=self.device, compute_type=self.compute_type,
                                             cpu_threads=self.cpu_threads, download_root=str(self.cache_dir),
                                             local_files_only=self.local_files_only)
        except ImportError as error:
            raise SpeechEngineError("DEPENDENCY_MISSING", "Install the Phase 1 Python dependencies") from error
        except Exception as error:
            code = "MODEL_UNAVAILABLE" if self.local_files_only else "MODEL_LOAD_FAILED"
            raise SpeechEngineError(code, "Model could not load; check cache integrity, connectivity, disk space and runtime libraries") from error
        self.model_load_seconds = perf_counter() - started

    def transcribe(self, wav_path: str | Path, *, language: str | None = None, beam_size: int = 5) -> Transcription:
        audio = read_wav(wav_path)
        if beam_size < 1:
            raise ValueError("Beam size must be positive")
        with self._lock:
            self._load()
            started = perf_counter()
            try:
                iterator, info = self._model.transcribe(audio.samples, language=language, beam_size=beam_size,
                                                       vad_filter=False, condition_on_previous_text=False)
                segments = [Segment(segment.text.strip(), round(segment.start * 1000), round(segment.end * 1000))
                            for segment in iterator]
            except Exception as error:
                raise SpeechEngineError("INFERENCE_FAILED", "Local transcription failed") from error
            elapsed = perf_counter() - started
        lang_prob = float(info.language_probability) if getattr(info, "language_probability", None) is not None else None
        return Transcription(" ".join(segment.text for segment in segments), segments, getattr(info, "language", language or "en"),
                             lang_prob, audio.duration_seconds, self.model_load_seconds,
                             elapsed, real_time_factor(elapsed, audio.duration_seconds))
