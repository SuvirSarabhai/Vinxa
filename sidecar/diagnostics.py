"""Opt-in bounded numeric diagnostics, independent of the speech wire contract."""

from collections import defaultdict
import json
import math
import os
from pathlib import Path
from time import perf_counter as monotonic


class Diagnostics:
    def __init__(self, path=None, limit=50000):
        self.path = path or os.environ.get("VINXA_DIAGNOSTICS_PATH")
        self.limit = limit
        self.events = []
        self.counters = defaultdict(lambda: defaultdict(int))
        self.omitted = 0
        self.sample_accounting = {}

    def record(self, stage, source, samples=0, **values):
        if not self.path:
            return
        if source not in ("mic", "system"):
            raise ValueError("Invalid diagnostic source")
        if any(not isinstance(value, (int, float, bool)) or not math.isfinite(value)
               for value in (samples, *values.values())):
            raise ValueError("Diagnostics accept numeric values only")
        self.counters[source][stage + "_count"] += 1
        self.counters[source][stage + "_samples"] += samples
        row = {"stage": stage, "source": source, "samples": samples,
               "sidecar_monotonic_seconds": monotonic(), **values}
        if len(self.events) < self.limit:
            self.events.append(row)
        else:
            self.omitted += 1

    def save(self):
        if self.path:
            with Path(self.path).open("x", encoding="utf-8") as output:
                json.dump({"clock": "sidecar process monotonic seconds; no cross-process offset established",
                           "counters": dict(self.counters), "events": self.events,
                           "sample_accounting": self.sample_accounting,
                           "omitted_diagnostic_rows": self.omitted}, output, allow_nan=False)
                output.write("\n")
