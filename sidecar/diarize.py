"""Optional local post-recording clustering. No model downloads or content logs."""
import json
import os
from pathlib import Path
import sys
import wave


def main():
    from sidecar.network_policy import install
    install()
    try:
        import numpy as np
        import sherpa_onnx as so
        segmentation = Path(os.environ["VINXA_DIARIZATION_SEGMENTATION"])
        embedding = Path(os.environ["VINXA_DIARIZATION_EMBEDDING"])
        if not segmentation.is_file() or not embedding.is_file():
            raise ValueError("Missing models")
        with wave.open(os.environ["VINXA_DIARIZATION_WAV"], "rb") as wav:
            if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (1, 16000, 2):
                raise ValueError("Unsupported recording")
            # Bound memory: long recordings retain Remote channel labels.
            if wav.getnframes() > 16000 * 60 * 60:
                raise ValueError("Recording exceeds one hour")
            audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
        config = so.OfflineSpeakerDiarizationConfig(
            segmentation=so.OfflineSpeakerSegmentationModelConfig(
                pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation))),
            embedding=so.SpeakerEmbeddingExtractorConfig(model=str(embedding)),
            clustering=so.FastClusteringConfig(num_clusters=-1, threshold=0.5),
            min_duration_on=0.3, min_duration_off=0.5,
        )
        if not config.validate():
            raise ValueError("Invalid model configuration")
        diarizer = so.OfflineSpeakerDiarization(config)
        if diarizer.sample_rate != 16000:
            raise ValueError("Unsupported model sample rate")
        turns = diarizer.process(audio).sort_by_start_time()
        result = [{"startMs": round(t.start * 1000), "endMs": round(t.end * 1000), "speaker": int(t.speaker)} for t in turns]
        if len(result) > 20000:
            raise ValueError("Too many turns")
        print(json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception:
        sys.stderr.write("Local speaker clustering failed; verify optional dependencies, model files and recording.\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
