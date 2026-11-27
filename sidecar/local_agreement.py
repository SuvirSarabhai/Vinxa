"""Pure timestamp-aware two-pass prefix agreement; no model or I/O."""

from dataclasses import dataclass
from collections import deque
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
        self.history = deque(maxlen=32)
        self.tolerance = tolerance_samples

    def _remaining(self, words):
        result = []
        cursor = self.committed_through
        for word in words:
            if word.end <= cursor or word.start < max(0, self.committed_through - self.tolerance) or not normalized(word.text):
                continue
            duplicate = False
            for old in self.history:
                if normalized(old.text) != normalized(word.text) or word.start >= self.committed_through:
                    continue
                old_distance = abs(word.start - old.start)
                pending_distance = min((abs(word.start - pending.start) for pending in self.previous
                                        if normalized(pending.text) == normalized(word.text)), default=float("inf"))
                # A repeated next word belongs to the pending hypothesis when its
                # timing is closer there. Do not confuse it with an overlapped final.
                if old_distance < pending_distance and old_distance < max(160, (old.end - old.start) // 2):
                    duplicate = True
                    break
            if not duplicate:
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
            self.history.extend(stable)
        self.previous = pending
        return stable, pending

    def finish(self, hypothesis):
        final = self._remaining(hypothesis)
        if final:
            self.committed_through = final[-1].end
            self.history.extend(final)
        self.previous = []
        return final
