"""Input conservation counters and bounded, deduplicated inference coverage."""

from collections import Counter


class SampleAccounting:
    def __init__(self):
        self.received = self.processed = self.padding = 0
        self.dropped = Counter()
        self.inferred = self.upstream_dropped = 0
        self.coverage = []
        self.coverage_floor = 0

    def infer(self, start, end):
        if start < self.coverage_floor or end < start:
            raise ValueError("Inference preceded retained coverage history")
        overlap = sum(max(0, min(end, right) - max(start, left)) for left, right in self.coverage)
        self.inferred += end - start - overlap
        merged = []
        for left, right in sorted([*self.coverage, (start, end)]):
            if merged and left <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(right, merged[-1][1]))
            else:
                merged.append((left, right))
        self.coverage = merged

    def retire(self, before):
        # Retire only history older than every possible future snapshot.
        self.coverage_floor = max(self.coverage_floor, before)
        self.coverage = [(max(left, self.coverage_floor), right)
                         for left, right in self.coverage if right > self.coverage_floor]

    def snapshot(self, pending):
        dropped = sum(self.dropped.values())
        return {"received_samples": self.received, "processed_samples": self.processed,
                "upstream_reported_dropped_samples": self.upstream_dropped,
                "padding_samples": self.padding, "input_dropped_samples": dropped,
                "input_drop_reasons": dict(self.dropped), "pending_samples": pending,
                "unexplained_samples": self.received - self.processed - self.padding - dropped - pending,
                "inferred_unique_samples": self.inferred,
                "processed_without_inference_samples": self.processed - self.inferred}
