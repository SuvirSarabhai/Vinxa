"""Reference-word matching and client-receipt latency; no text is persisted."""

from difflib import SequenceMatcher
from statistics import median
import numpy as np

from sidecar.local_agreement import normalized


def distribution(values):
    return {"count": len(values), "median_ms": float(median(values)) if values else None,
            "p95_ms": float(np.percentile(values, 95)) if values else None,
            "maximum_ms": float(max(values)) if values else None}


class Measurements:
    def __init__(self, references, silence_intervals=None):
        self.references = references
        self.silence = silence_intervals or {}
        self.sent = {s: {} for s in references}
        self.first_partial = {}
        self.latencies = {s: {"partial": {}, "final": {}} for s in references}
        self.counts = {s: {"partial": 0, "final": 0, "empty_final": 0, "silence_false_positives": 0,
                           "unmatched_emitted_words": 0, "negative_estimates": 0} for s in references}
        self.inference = {s: [] for s in references}
        self.queue_wait = {s: [] for s in references}
        self.max_queue = self.dropped_samples = 0
        self.errors = {}

    def sent_frame(self, source, index, when):
        self.sent[source][index] = when

    def observe(self, event, received):
        if event["type"] == "error":
            code = event["code"]
            self.errors[code] = self.errors.get(code, 0) + 1
            return
        if event["type"] == "status":
            metric = event.get("metrics")
            if metric:
                self.max_queue = max(self.max_queue, metric["queueDepth"])
                self.dropped_samples += metric["droppedSamples"]
                if "inferenceMs" in metric:
                    self.inference[metric["source"]].append(metric["inferenceMs"])
                if "queueWaitMs" in metric:
                    self.queue_wait[metric["source"]].append(metric["queueWaitMs"])
            return
        source, kind = event["source"], event["type"]
        if not event["text"].strip():
            if kind == "final":
                self.counts[source]["empty_final"] += 1
            return
        self.counts[source][kind] += 1
        if kind == "partial":
            self.first_partial.setdefault(source, received)
        if any(event["startMs"] >= start and event["endMs"] <= end for start, end in self.silence.get(source, [])):
            self.counts[source]["silence_false_positives"] += 1
        tokens = [normalized(t) for t in event["text"].split() if normalized(t)]
        candidates = [(index, word) for index, word in enumerate(self.references[source])
                      if word.end / 16 >= event["startMs"] - 500 and word.start / 16 <= event["endMs"] + 500]
        matching = SequenceMatcher(None, [normalized(word.text) for _, word in candidates], tokens, autojunk=False)
        matched = 0
        for block in matching.get_matching_blocks():
            for offset in range(block.size):
                index, word = candidates[block.a + offset]
                arrival = self.sent[source].get(max(0, (word.end - 1) // 1600))
                if arrival is None:
                    continue
                latency = (received - arrival) * 1000
                if latency < 0:
                    self.counts[source]["negative_estimates"] += 1
                    continue
                self.latencies[source][kind].setdefault(index, latency)
                matched += 1
        self.counts[source]["unmatched_emitted_words"] += max(0, len(tokens) - matched)

    def report(self):
        sources = {}
        for source, words in self.references.items():
            first = min(self.sent[source].values()) if self.sent[source] else None
            partial, final = self.latencies[source]["partial"], self.latencies[source]["final"]
            sources[source] = {**self.counts[source], "reference_words": len(words),
                "partial_word_coverage": len(partial) / len(words) if words else None,
                "final_word_coverage": len(final) / len(words) if words else None,
                "time_to_first_partial_ms": (self.first_partial[source] - first) * 1000
                    if source in self.first_partial and first is not None else None,
                "partial_client_receipt_latency": distribution(list(partial.values())),
                "final_client_receipt_latency": distribution(list(final.values())),
                "inference_pass": distribution(self.inference[source]),
                "queue_wait": distribution(self.queue_wait[source])}
        return {"sources": sources, "maximum_observed_queue_depth": self.max_queue,
                "reported_dropped_samples": self.dropped_samples, "errors": self.errors}
