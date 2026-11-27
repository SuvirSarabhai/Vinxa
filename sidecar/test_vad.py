import numpy as np
import pytest

from sidecar.vad import SileroScorer, VadGate, VadSettings, WINDOW


class Scores:
    def __init__(self, values=()):
        self.values = list(values)
        self.calls = 0

    def reset(self):
        self.calls = 0

    def __call__(self, samples):
        assert len(samples) == WINDOW
        value = self.values[self.calls] if self.calls < len(self.values) else 0
        self.calls += 1
        return value


def test_rechunk_boundaries_short_pauses_and_trailing_flush():
    scorer = Scores([0] * 2 + [0.9] * 5 + [0] * 2 + [0.9] * 4 + [0] * 20)
    gate = VadGate(scorer)
    events = []
    for _ in range(11):
        events.extend(gate.feed(np.zeros(1600, np.float32)))
        assert len(gate.pending) < 512
    assert [e.kind for e in events] == ["start", "end"]
    assert events[0].sample == 0
    assert events[1].sample > 13 * WINDOW
    assert gate.flush() == []


def test_continuous_speech_and_source_isolation():
    first, second = VadGate(Scores([0.9] * 100)), VadGate(Scores())
    starts = first.feed(np.zeros(1600))
    assert [e.kind for e in starts] == ["start"]
    assert second.feed(np.zeros(1600)) == [] and not second.active
    assert [e.kind for e in first.flush()] == ["end"]
    assert not first.active and not len(first.pending)


def test_empty_very_short_input_reset_and_no_spurious_speech():
    gate = VadGate(Scores([0.9] * 20))
    assert gate.feed(np.empty(0)) == []
    assert gate.feed(np.ones(10)) == []
    assert gate.flush() == []  # too short to satisfy minimum speech
    gate.reset(8000)
    assert gate.cursor == 8000 and gate.anchor == 8000


@pytest.mark.parametrize("settings", [dict(threshold=2), dict(release=0.8), dict(min_speech_samples=0)])
def test_invalid_config(settings):
    with pytest.raises(ValueError):
        VadSettings(**settings)


def test_real_silero_silence_and_independent_recurrent_state():
    first, second = SileroScorer(), SileroScorer()
    assert first.h is not second.h and first.context is not second.context
    for _ in range(12):
        assert first(np.zeros(512, np.float32)) < 0.5
    assert not np.any(second.h)
    first.reset()
    assert not np.any(first.h)
