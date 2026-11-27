import json

import pytest

from sidecar.diagnostics import Diagnostics


def test_bounded_numeric_trace_keeps_totals_after_detail_limit(tmp_path):
    path = tmp_path / "trace.json"
    diagnostic = Diagnostics(path, limit=1)
    diagnostic.record("received", "mic", 1600, sequence=0)
    diagnostic.record("received", "mic", 1600, sequence=1)
    diagnostic.record("received", "system", 1600, sequence=0)
    diagnostic.save()
    report = json.loads(path.read_text())
    assert report["counters"]["mic"]["received_samples"] == 3200
    assert report["counters"]["system"]["received_samples"] == 1600
    assert len(report["events"]) == 1
    assert report["omitted_diagnostic_rows"] == 2
    with pytest.raises(ValueError):
        diagnostic.record("received", "mic", transcript="private-test-phrase")
    assert "private-test-phrase" not in path.read_text()


def test_trace_preserves_existing_files(tmp_path):
    path = tmp_path / "trace.json"
    path.write_text("existing")
    with pytest.raises(FileExistsError):
        Diagnostics(path).save()
    assert path.read_text() == "existing"
