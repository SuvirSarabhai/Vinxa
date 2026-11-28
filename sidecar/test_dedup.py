from sidecar.dedup import EchoDeduplicator


def event(source, text, start=0, end=1000, final=True, identity=None):
    return {"id": identity or source + str(start), "source": source, "text": text,
            "startMs": start, "endMs": end, "type": "final" if final else "partial"}


def test_exact_echo_uses_source_and_normalization():
    dedup = EchoDeduplicator()
    dedup.inspect(event("system", "We will review the project tomorrow."))
    assert dedup.inspect(event("mic", "WE will review the project tomorrow!", 200, 1200)) == (False, "matching_remote_final")


def test_similar_long_echo_is_suppressed():
    dedup = EchoDeduplicator()
    text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen"
    dedup.inspect(event("system", text))
    assert dedup.inspect(event("mic", text.replace("eighteen", "eighteens")))[0] is False


def test_short_reply_extension_and_different_time_are_kept():
    dedup = EchoDeduplicator()
    dedup.inspect(event("system", "Yes, I agree."))
    assert dedup.inspect(event("mic", "Yes, I agree, let's continue."))[0]
    dedup.inspect(event("system", "We will review the project tomorrow.", identity="remote2"))
    assert dedup.inspect(event("mic", "We will review the project tomorrow.", 10000, 11000))[0]


def test_partial_cannot_suppress_a_final_and_committed_mic_is_never_removed():
    dedup = EchoDeduplicator()
    phrase = "We will review the project tomorrow."
    dedup.inspect(event("system", phrase, final=False))
    assert dedup.inspect(event("mic", phrase, identity="mic-final"))[0]
    dedup.inspect(event("system", phrase))
    assert dedup.inspect(event("mic", phrase, identity="mic-final")) == (True, "already_committed")
    assert dedup.inspect(event("mic", phrase, final=False, identity="provisional"))[0]
    assert not dedup.inspect(event("mic", phrase, identity="provisional"))[0]
