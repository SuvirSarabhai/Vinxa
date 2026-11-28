import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


MODELS = ("base.en", "small", "tiny.en")
MODEL_FILES = ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json",
               "vocabulary.json", "vocabulary.txt", "LICENSE", "README.md")


def selected_model(model, path=None):
    if model not in MODELS:
        raise ValueError("Unsupported bundled model")
    if path is None:
        from huggingface_hub import try_to_load_from_cache
        from .engine import model_cache
        weights = try_to_load_from_cache(repo_id=f"Systran/faster-whisper-{model}",
                                         filename="model.bin", cache_dir=str(model_cache()))
        if not isinstance(weights, str):
            raise ValueError("The selected model is missing from the cache. Prepare the model cache first.")
        path = Path(weights).parent
    directory = Path(path).expanduser().resolve()
    for required in ("model.bin", "config.json", "tokenizer.json"):
        if not (directory / required).is_file():
            raise ValueError("The selected converted model is incomplete. Prepare the model cache first.")
    return directory


def build_arguments(root):
    build = root / "build" / "python"
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir", "--console", "--noupx",
            "--name", "vinxa-sidecar", "--distpath", str(build / "dist"),
            "--workpath", str(build / "work"), "--specpath", str(build), "--paths", str(root),
            "--add-data", f"{root / 'sidecar' / 'wire-schema.json'}:sidecar"]
    for package in ("faster_whisper", "ctranslate2", "onnxruntime", "tokenizers", "huggingface_hub",
                    "websockets", "jsonschema", "referencing", "jsonschema_specifications", "av"):
        args.extend(["--collect-all", package])
    for package in ("faster-whisper", "jsonschema", "websockets"):
        args.extend(["--recursive-copy-metadata", package])
    # Phase 5 remains optional: normal packaging does not acquire new models.
    if os.environ.get("VINXA_PACKAGE_DIARIZATION") == "1":
        args.extend(["--collect-all", "sherpa_onnx"])
    for package in ("torch", "tensorflow", "pytest"):
        args.extend(["--exclude-module", package])
    args.append(str(root / "sidecar" / "entrypoint.py"))
    return args


def build_runtime(model, model_path=None):
    if sys.platform != "win32":
        raise RuntimeError("Build the Windows speech runtime on Windows.")
    root = Path(__file__).resolve().parents[1]
    build = (root / "build").resolve()
    if build.parent != root or any(not path.resolve().is_relative_to(build)
                                  for path in (build / "python", build / "python/dist", build / "python/work")):
        raise RuntimeError("Generated build paths must stay inside the project's build directory.")
    directory = selected_model(model, model_path)
    subprocess.run(build_arguments(root), cwd=root, check=True)
    frozen = build / "python" / "dist" / "vinxa-sidecar"
    if not (frozen / "vinxa-sidecar.exe").is_file():
        raise RuntimeError("The frozen speech executable was not produced.")
    stage = build / f"sidecar-stage-{uuid.uuid4().hex}"
    shutil.copytree(frozen, stage)
    destination = stage / "models" / model
    destination.mkdir(parents=True)
    for name in MODEL_FILES:
        if (directory / name).is_file():
            shutil.copy2(directory / name, destination / name)
    (stage / "runtime.json").write_text(json.dumps({"runtime": "pyinstaller-onedir", "model": model,
        "modelPath": f"models/{model}", "python": sys.version.split()[0]}, indent=2), encoding="utf8")
    target = build / "sidecar"
    backup = build / f"sidecar-backup-{uuid.uuid4().hex}"
    if any(path.resolve().parent != build for path in (stage, target, backup)):
        raise RuntimeError("Runtime output must stay inside the project's build directory.")
    if target.exists():
        target.rename(backup)
        print(f"Previous generated runtime retained at {backup}")
    try:
        stage.rename(target)
    except OSError:
        if backup.exists() and not target.exists():
            backup.rename(target)
        raise
    print(f"Windows speech runtime and cached {model} files prepared at {target}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=MODELS, default=os.environ.get("VINXA_SPEECH_MODEL") or "base.en")
    parser.add_argument("--model-path", type=Path)
    args = parser.parse_args()
    build_runtime(args.model, args.model_path)


if __name__ == "__main__":
    main()
