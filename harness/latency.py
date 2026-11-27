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
                           "unmatched_emitted_words": 0, "negative_estimates": 0, "negative_capture_estimates": 0} for s in references}
        self.inference = {s: [] for s in references}
        self.queue_wait = {s: [] for s in references}
        self.max_queue = self.dropped_samples = 0
        self.errors = {}
        self.events = []
        self.event_limit = 50000
        self.omitted_events = 0
        self.clock_offset_ms = None
        self.event_latencies = {s: {k: [] for k in ("partial", "final", "delivery", "processing", "finalization", "receive_partial", "receive_final")} for s in references}
        self.send_durations = {source: [] for source in references}
        self.pacing_jitter = []
        self.sent_samples = {source: 0 for source in references}

    def sent_frame(self, source, index, when):
        self.sent[source][index] = when

    def delivery(self, source, samples, started, completed):
        self.sent_samples[source] += samples
        self.send_durations[source].append((completed - started) * 1000)

    def observe(self, event, received):
        source = event.get("source")
        row = {"event_index": len(self.events) + self.omitted_events,
               "event_id": event.get("id", "unavailable"), "session_id": event.get("sessionId", "unavailable"),
               "source_id": {"mic": 0, "system": 1}.get(source, "unavailable"),
               "source": source or "unavailable", "type": event["type"],
               "client_receive_monotonic_seconds": received,
               "text": "unavailable", "text_reason": "redacted by privacy rule",
               "audio_start_ms": event.get("startMs", "unavailable"),
               "audio_end_ms": event.get("endMs", "unavailable"),
               "capture_timestamp": "unavailable", "frame_delivery_timestamp": "unavailable",
               "sidecar_receive_timestamp": "unavailable", "transcription_start_timestamp": "unavailable",
               "transcription_completion_timestamp": "unavailable", "emission_timestamp": "unavailable",
               "measured_capture_latency_ms": "unavailable",
               "empty_text": not bool(event.get("text", "").strip()),
               "matched_reference_words": 0}
        if source and "endMs" in event:
            frame_index = max(0, (round(event["endMs"] * 16) - 1) // 1600)
            delivered = self.sent[source].get(frame_index)
            row["inferred_end_frame_index"] = frame_index
            if delivered is not None:
                row["frame_delivery_timestamp"] = delivered
                row["event_end_frame_to_client_receipt_ms"] = (received - delivered) * 1000
        timing = event.get("timing")
        if timing:
            row["source_timing"] = timing
            row["first_frame_sequence"] = timing["firstSequence"]
            row["last_frame_sequence"] = timing["lastSequence"]
            row["capture_timestamp"] = timing["captureEndMs"]
            row["frame_delivery_timestamp"] = timing["sentMs"]
            row["sidecar_receive_timestamp"] = timing["receivedMs"]
            row["transcription_start_timestamp"] = timing["inferenceStartMs"]
            row["transcription_completion_timestamp"] = timing["inferenceEndMs"]
            row["emission_timestamp"] = timing["emittedMs"]
            row["timestamp_clock"] = timing["clock"]
            if event.get("text", "").strip():
                processing = timing["inferenceEndMs"] - timing["inferenceStartMs"]
                self.event_latencies[source]["processing"].append(processing)
                row["sidecar_processing_ms"] = processing
                if self.clock_offset_ms is not None:
                    captured = received * 1000 - (timing["captureEndMs"] - self.clock_offset_ms)
                    delivered = received * 1000 - (timing["sentMs"] - self.clock_offset_ms)
                    row["measured_capture_latency_ms"] = captured
                    if captured < 0:
                        self.counts[source]["negative_capture_estimates"] += 1
                    received_latency = received * 1000 - (timing["receivedMs"] - self.clock_offset_ms)
                    row["sidecar_receive_latency_ms"] = received_latency
                    self.event_latencies[source]["receive_" + event["type"]].append(received_latency)
                    row["delivery_latency_ms"] = delivered
                    self.event_latencies[source][event["type"]].append(captured)
                    self.event_latencies[source]["delivery"].append(delivered)
                if "finalizationStartMs" in timing:
                    duration = timing["emittedMs"] - timing["finalizationStartMs"]
                    row["finalization_duration_ms"] = duration
                    self.event_latencies[source]["finalization"].append(duration)
        if event["type"] == "status":
            row["status"] = event["status"]
            row["metrics"] = event.get("metrics", {})
        if event["type"] == "error":
            row["code"] = event["code"]
        if len(self.events) < self.event_limit:
            self.events.append(row)
        else:
            self.omitted_events += 1
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
        row["matched_reference_words"] = matched
        self.counts[source]["unmatched_emitted_words"] += max(0, len(tokens) - matched)

    def attach_sidecar_timing(self, diagnostic):
        # All attached timestamps remain in the sidecar clock domain.
        # IDs and occurrence order join observations without comparing clocks.
        emissions = {}
        inference = {}
        starts = {}
        receive_times = {}
        for row in diagnostic["events"]:
            source, stage = row["source"], row["stage"]
            if stage == "server_received":
                receive_times.setdefault(source, []).append(row["sidecar_monotonic_seconds"])
            if stage == "inference_start":
                starts[source] = row
            if stage == "inference_complete":
                inference[source] = row
            if stage == "text_emitted":
                key = (source, row["generation"], row["utterance"], row["chunk"], row["final"])
                emissions.setdefault(key, []).append((row, starts.get(source), inference.get(source)))
        for event in self.events:
            if event["type"] not in ("partial", "final"):
                continue
            try:
                _, generation, source, utterance, chunk = event["event_id"].rsplit(":", 4)
                key = (source, int(generation), int(utterance), int(chunk), event["type"] == "final")
            except ValueError:
                continue
            candidates = emissions.get(key, [])
            if not candidates:
                continue
            emitted, dispatched, completed = candidates.pop(0)
            if "source_timing" in event:
                continue
            event["emission_timestamp"] = emitted["sidecar_monotonic_seconds"]
            event["sidecar_clock_domain"] = "sidecar process monotonic seconds"
            if "inference_origin" in emitted:
                completed = ({"worker_start": emitted.get("worker_start"), "worker_complete": emitted.get("worker_complete"),
                              "duration_ms": emitted.get("duration_ms"), "start": emitted["window_start"],
                              "end": emitted["window_end"]} if emitted["inference_origin"] else None)
                dispatched = {"queue_wait_ms": emitted["queue_wait_ms"]} if emitted["inference_origin"] else None
            if completed:
                event["transcription_start_timestamp"] = completed.get("worker_start") or "unavailable"
                event["transcription_completion_timestamp"] = completed.get("worker_complete") or "unavailable"
                event["sidecar_inference_duration_ms"] = completed["duration_ms"]
                event["inference_window_start_sample"] = completed["start"]
                event["inference_window_end_sample"] = completed["end"]
            if dispatched:
                event["queue_wait_ms"] = dispatched["queue_wait_ms"]
            frame_index = event.get("inferred_end_frame_index")
            source_receives = receive_times.get(source, [])
            if frame_index is not None and frame_index < len(source_receives):
                event["sidecar_receive_timestamp"] = source_receives[frame_index]
                event["frame_association"] = "inferred ordinal from model-aligned end; legacy protocol has no sequence header"

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
                "capture_to_partial_ms": distribution(self.event_latencies[source]["partial"]),
                "capture_to_final_ms": distribution(self.event_latencies[source]["final"]),
                "sidecar_receive_to_partial_ms": distribution(self.event_latencies[source]["receive_partial"]),
                "sidecar_receive_to_final_ms": distribution(self.event_latencies[source]["receive_final"]),
                "delivery_to_event_ms": distribution(self.event_latencies[source]["delivery"]),
                "sidecar_processing_ms": distribution(self.event_latencies[source]["processing"]),
                "finalization_ms": distribution(self.event_latencies[source]["finalization"]),
                "frames_sent": len(self.sent[source]), "samples_sent_including_padding": self.sent_samples[source],
                "websocket_send_duration_ms": distribution(self.send_durations[source]),
                "inference_pass": distribution(self.inference[source]),
                "queue_wait": distribution(self.queue_wait[source])}
        return {"sources": sources, "maximum_observed_queue_depth": self.max_queue,
                "reported_dropped_samples": self.dropped_samples, "errors": self.errors,
                "event_log": self.events, "omitted_event_rows": self.omitted_events,
                "replay_pacing_jitter_ms": distribution(self.pacing_jitter),
                "timing_model": {
                    "client": "monotonic seconds within replay process",
                    "sidecar": "high-resolution monotonic seconds; clock_translation supplies server_ms minus client_ms when negotiated",
                    "audio": "source-relative sample positions at 16000 Hz",
                    "event_end_frame_latency": "legacy proxy using model-aligned event end and client send completion",
                    "reference_word_latency": "client receipt minus send completion of matched reference word end frame",
                    "electron_hops": "unavailable during WAV replay; physical capture path bypassed"}}
