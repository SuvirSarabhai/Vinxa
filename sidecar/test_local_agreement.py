from sidecar.local_agreement import LocalAgreement, Word


def words(*items):
    return [Word(text, i * 1600, (i + 1) * 1600) for i, text in enumerate(items)]


def test_stability_revisions_punctuation_and_no_duplicate_commits():
    agreement = LocalAgreement()
    assert agreement.update(words("Hello", "wrong"))[0] == []
    stable, pending = agreement.update(words("Hello,", "world"))
    assert [w.text for w in stable] == ["Hello,"]
    assert [w.text for w in pending] == ["world"]
    stable, pending = agreement.update(words("Hello,", "world!"))
    assert [w.text for w in stable] == ["world!"] and not pending
    assert agreement.update(words("Hello,", "world!")) == ([], [])


def test_repeated_words_and_final_flush_once():
    agreement = LocalAgreement()
    agreement.update(words("yes", "yes", "okay"))
    stable, _ = agreement.update(words("yes", "yes", "later"))
    assert [w.text for w in stable] == ["yes", "yes"]
    assert [w.text for w in agreement.finish(words("yes", "yes", "now"))] == ["now"]
    assert agreement.finish(words("yes", "yes", "now")) == []


def test_empty_and_earlier_hypothesis_revisions_do_not_change_finals():
    agreement = LocalAgreement()
    agreement.update(words("a", "b"))
    agreement.update(words("a", "c"))
    assert agreement.committed_through == 1600
    assert agreement.update([]) == ([], [])
    assert agreement.finish([Word("revision", 0, 1500)]) == []


def test_large_timestamp_shift_is_not_agreement():
    agreement = LocalAgreement()
    agreement.update([Word("hello", 0, 1600)])
    assert agreement.update([Word("hello", 10000, 12000)])[0] == []


def test_timestamp_drift_across_commit_boundary_preserves_new_word_without_retiming():
    agreement = LocalAgreement()
    agreement.update([Word("hello", 0, 1600), Word("world", 1600, 3200)])
    stable, _ = agreement.update([Word("hello", 0, 1600), Word("world", 1500, 3200)])
    assert [word.text for word in stable] == ["hello", "world"]
    assert stable[-1].start == 1500  # original alignment retained, not adjusted
    assert agreement.update([Word("hello", 0, 1700), Word("world", 1500, 3300)]) == ([], [])


def test_repeated_pending_word_is_not_mistaken_for_overlap_duplicate():
    agreement = LocalAgreement()
    agreement.update([Word("yes", 0, 1600), Word("yes", 1600, 3200)])
    stable, _ = agreement.update([Word("yes", 0, 1600), Word("maybe", 1600, 3200)])
    assert len(stable) == 1
    agreement.update([Word("yes", 1500, 3200)])
    stable, _ = agreement.update([Word("yes", 1550, 3200)])
    assert [word.text for word in stable] == ["yes"]
