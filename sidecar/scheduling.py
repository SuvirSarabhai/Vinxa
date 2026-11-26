"""Bounded round-robin inference queue; callers own one inference worker."""

import asyncio
from collections import deque


class FairQueue:
    def __init__(self, sources, per_source=2):
        if not 1 <= per_source <= 8:
            raise ValueError("Invalid inference queue bound")
        self.sources = tuple(sources)
        self.pending = {source: deque() for source in sources}
        self.limit = per_source
        self.cursor = 0
        self.wake = asyncio.Event()
        self.closed = False

    @property
    def depth(self):
        return sum(len(queue) for queue in self.pending.values())

    def put(self, job):
        if self.closed:
            return False
        queue = self.pending[job.source]
        for index, old in enumerate(queue):
            if old.key == job.key and not old.final:
                queue[index] = job
                self.wake.set()
                return True
        if len(queue) >= self.limit:
            for index, old in enumerate(queue):
                if not old.final:
                    del queue[index]
                    break
            else:
                return False
        queue.append(job)
        self.wake.set()
        return True

    async def get(self):
        while not self.closed:
            for offset in range(len(self.sources)):
                index = (self.cursor + offset) % len(self.sources)
                queue = self.pending[self.sources[index]]
                if queue:
                    self.cursor = (index + 1) % len(self.sources)
                    return queue.popleft()
            self.wake.clear()
            await self.wake.wait()
        return None

    def clear(self, source=None):
        for name, queue in self.pending.items():
            if source is None or source == name:
                queue.clear()

    def close(self):
        self.closed = True
        self.clear()
        self.wake.set()
