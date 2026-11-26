"""A bounded per-source sample buffer with explicit eviction accounting."""

from collections import deque
import numpy as np


class AudioBuffer:
    def __init__(self, capacity=320000, start_sample=0):
        if not isinstance(capacity, int) or capacity < 1600:
            raise ValueError("Invalid audio buffer capacity")
        self.capacity = capacity
        self.reset(start_sample)

    def reset(self, start_sample):
        self.start = self.end = start_sample
        self.chunks = deque()

    def append(self, samples):
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim != 1 or not np.isfinite(samples).all():
            raise ValueError("Invalid mono samples")
        if len(samples):
            self.chunks.append(samples.copy())
            self.end += len(samples)
        dropped = max(0, self.end - self.start - self.capacity)
        self.trim(self.start + dropped)
        return dropped

    def trim(self, sample):
        sample = min(self.end, max(self.start, sample))
        remaining = sample - self.start
        while remaining and self.chunks:
            chunk = self.chunks[0]
            if len(chunk) <= remaining:
                remaining -= len(self.chunks.popleft())
            else:
                self.chunks[0] = chunk[remaining:].copy()
                remaining = 0
        self.start = sample

    def snapshot(self, start=None, end=None):
        start = self.start if start is None else max(self.start, start)
        end = self.end if end is None else min(self.end, end)
        if end <= start:
            return np.empty(0, dtype=np.float32), start
        data = np.concatenate(tuple(self.chunks))
        return data[start - self.start:end - self.start].copy(), start
