"""Conservative, source-based echo filtering. Audio and committed text are untouched."""
from collections import deque
from difflib import SequenceMatcher
import re
import unicodedata


def tokens(text):
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return re.findall(r"\w+(?:['’]\w+)?", normalized)


class EchoDeduplicator:
    def __init__(self, window_ms=2000):
        self.window_ms = window_ms
        self.remote = deque(maxlen=128)
        self.committed = set()

    def inspect(self, event):
        identity = event["id"]
        final = event["type"] == "final"
        text = tokens(event["text"])
        if identity in self.committed:
            return True, "already_committed"
        if event["source"] == "system":
            if final and text:
                self.remote.append((text, event["startMs"], event["endMs"]))
                self.committed.add(identity)
            return True, "system_source"
        # A provisional hypothesis may grow into a genuine response. Keep it until final.
        if not final:
            return True, "provisional"
        if len(text) < 4:
            self.committed.add(identity)
            return True, "short_response"
        for remote, start, end in reversed(self.remote):
            if abs(event["startMs"] - start) > self.window_ms or abs(event["endMs"] - end) > self.window_ms:
                continue
            # Preserve added words and short agreements, even when they share a prefix.
            if len(remote) != len(text):
                continue
            similarity = SequenceMatcher(None, remote, text, autojunk=False).ratio()
            if remote == text or (len(text) >= 8 and similarity >= 0.94):
                return False, "matching_remote_final"
        self.committed.add(identity)
        return True, "distinct_speech"
