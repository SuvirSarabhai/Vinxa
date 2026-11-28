from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

from sidecar.package_runtime import build_arguments, selected_model


def model_files(path):
    path.mkdir()
    for name in ("model.bin", "config.json", "tokenizer.json"):
        (path / name).write_bytes(b"fixture")
    return path


def test_selects_only_a_complete_explicit_converted_model(tmp_path):
    path = model_files(tmp_path / "model")
    assert selected_model("base.en", path) == path.resolve()
    (path / "tokenizer.json").unlink()
    with pytest.raises(ValueError, match="incomplete"):
        selected_model("base.en", path)


def test_model_lookup_uses_only_the_existing_cache(monkeypatch, tmp_path):
    directory = model_files(tmp_path / "model")
    calls = []
    def try_to_load_from_cache(**kwargs):
        calls.append(kwargs)
        return str(directory / "model.bin")
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(try_to_load_from_cache=try_to_load_from_cache))
    monkeypatch.setattr("sidecar.engine.model_cache", lambda: tmp_path / "cache")
    assert selected_model("base.en") == directory.resolve()
    assert calls == [{"repo_id": "Systran/faster-whisper-base.en", "filename": "model.bin", "cache_dir": str(tmp_path / "cache")}]


def test_missing_cached_model_reports_setup_error(monkeypatch):
    monkeypatch.setattr("huggingface_hub.try_to_load_from_cache", lambda **kwargs: None)
    with pytest.raises(ValueError, match="missing from the cache"):
        selected_model("base.en")


def test_frozen_build_includes_schema_vad_native_libraries_and_metadata():
    args = build_arguments(Path("project"))
    assert "--onedir" in args and "--onefile" not in args
    assert "--console" in args
    assert any(value.endswith("wire-schema.json:sidecar") for value in args)
    packages = [args[index + 1] for index, value in enumerate(args) if value == "--collect-all"]
    assert {"faster_whisper", "ctranslate2", "onnxruntime", "websockets", "jsonschema_specifications"} <= set(packages)
