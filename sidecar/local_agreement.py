"""Pure timestamp-aware two-pass prefix agreement; no model or I/O."""

from dataclasses import dataclass
import unicodedata


@dataclass(frozen=True)
class Word:
    text: str
    start: int  # absolute session samples
    end: int

    def __post_init__(self):
        if self.start < 0 or self.end < self.start:
            raise ValueError("Invalid word timestamps")


def normalized(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum() or c in "'’")


class LocalAgreement:
    def __init__(self, start_sample=0, tolerance_samples=6400):
        self.committed_through = start_sample
        self.previous = []
        self.tolerance = tolerance_samples

    def _remaining(self, words):
        result = []
        cursor = self.committed_through
        for word in words:
            # Revisions overlapping an immutable final are discarded, not retimed.
            if word.start >= cursor and word.end > self.committed_through and normalized(word.text):
                result.append(word)
                cursor = word.end
        return result

    def update(self, hypothesis):
        current = self._remaining(hypothesis)
        count = 0
        for old, new in zip(self.previous, current):
            if normalized(old.text) != normalized(new.text) or abs(old.start - new.start) > self.tolerance:
                break
            count += 1
        stable, pending = current[:count], current[count:]
        if stable:
            self.committed_through = stable[-1].end
        self.previous = pending
        return stable, pending

    def finish(self, hypothesis):
        final = self._remaining(hypothesis)
        if final:
            self.committed_through = final[-1].end
        self.previous = []
        return final
