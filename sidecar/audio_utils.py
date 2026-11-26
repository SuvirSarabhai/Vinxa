"""Validated PCM WAV input, independent of the capture backend."""

from dataclasses import dataclass
from pathlib import Path
import wave

import numpy as np


class AudioValidationError(ValueError):
    """Input is missing, malformed, empty, or outside the PCM contract."""


@dataclass(frozen=True)
class WavAudio:
    samples: np.ndarray
    duration_seconds: float
    sample_rate: int
    full_scale_samples: int


def read_wav(path: str | Path) -> WavAudio:
    target = Path(path)
    if not target.is_file():
        raise AudioValidationError("Input WAV does not exist or is not a file")
    try:
        with wave.open(str(target), "rb") as audio:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (16000, 1, 2, "NONE"):
                raise AudioValidationError("Expected 16000 Hz mono signed 16-bit PCM WAV")
            count = audio.getnframes()
            raw = audio.readframes(count)
    except (wave.Error, EOFError, OSError) as error:
        raise AudioValidationError("Could not read a valid PCM WAV") from error
    if count == 0 or len(raw) != count * 2:
        raise AudioValidationError("WAV is empty or its sample data is truncated")
    pcm = np.frombuffer(raw, dtype="<i2")
    samples = pcm.astype(np.float32) / 32768.0
    if not np.any(pcm):
        raise AudioValidationError("WAV contains only silence")
    full_scale = int(np.count_nonzero((pcm == -32768) | (pcm == 32767)))
    return WavAudio(samples, count / 16000, 16000, full_scale)


def real_time_factor(inference_seconds: float, duration_seconds: float) -> float:
    if not np.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("Audio duration must be positive and finite")
    if not np.isfinite(inference_seconds) or inference_seconds < 0:
        raise ValueError("Inference time must be nonnegative and finite")
    return inference_seconds / duration_seconds
