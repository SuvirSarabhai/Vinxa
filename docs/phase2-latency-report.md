# Phase 2 latency and measurement report

Status DONE for the three automated timed replays. Fresh-call timing and recognition quality are MANUAL-PENDING. The user deferred manual testing to the final Phase 2 validation pass.

## Final timed runs

All three runs use base.en CPU INT8, four threads, beam 1, a one-second inference cadence and a six-second maximum window. Both inputs are the retained 29.981-second real-call recordings, replayed at real-time pace with two seconds of leading and trailing silence. Capture timestamps represent simulated acquisition on the replay clock.

| Run | Source | Nonempty partials | Nonempty finals | Capture-end to partial median ms | Partial p95 ms | Final p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | mic | 1 | 2 | 1420.3 | 1420.3 | 2459.3 |
| 1 | system | 17 | 8 | 1102.5 | 1648.2 | 2485.5 |
| 2 | mic | 2 | 3 | 1151.9 | 1480.1 | 2202.2 |
| 2 | system | 17 | 7 | 1087.4 | 1635.8 | 2507.4 |
| 3 | mic | 2 | 3 | 1579.0 | 1914.6 | 2595.0 |
| 3 | system | 17 | 8 | 1022.3 | 1700.3 | 2716.1 |

All timed segment-end targets pass in each run. Accepted input is 544000 samples per source, including 299 padding samples. Each source processes 543701 samples. Input drops, pending samples, unexplained samples and the reported context-loss total are zero in all three runs. Negative capture estimates are zero.

## Pooled timed results

| Source | Event | Count | Median ms | P95 ms | Maximum ms |
| --- | --- | --- | --- | --- | --- |
| mic | partial | 5 | 1420.3 | 1864.9 | 1951.9 |
| mic | final | 8 | 2181.8 | 2593.9 | 2595.4 |
| system | partial | 51 | 1097.4 | 1729.7 | 1980.0 |
| system | final | 23 | 2074.2 | 2575.2 | 2789.6 |

Mic has only one or two nonempty partial events per run. The offline reference model accepts zero mic words in the current alignment pass. Mic reference coverage and WER are unavailable. System reference coverage for partials is about 48.9 percent of 45 reference words. These limits require a longer human-annotated corpus and the fresh-call check.

## Metric definitions

Capture-end to event uses the acquisition timestamp of the emitted segment's final recognized sample and the client receipt timestamp. The frame-to-segment association comes from copied source-frame provenance. Offset and uncertainty are measured through clock exchanges.

Sender-dispatch to client receipt is retained in delivery_to_event_ms for compatibility. Sidecar-receive-to-partial and sidecar-receive-to-final use the application receive timestamp translated into the client clock. Inference duration uses worker entry and completion. Finalization duration uses the observed end-of-speech start through emission when that start exists.

The historical reports measured receipt delay for matched model-reference words. These endpoints support separate comparisons. A change in endpoint does not establish a change in recognition accuracy. Every event is retained, including unmatched hypotheses and empty revisions. Text is redacted under the privacy rule.

Physical acquisition estimates originate at the audio rendering graph. Their uncertainty includes clock exchange, graph/resampler timing and observed residual. Hardware input latency is unmeasured. Physical-call acceptance remains REQUIRES MANUAL TEST.

## Inference profile

| CPU threads | Total s | Encoder s | Alignment s | Decode s | Accepted words |
| --- | --- | --- | --- | --- | --- |
| 2 | 0.774 | 0.566 | 0.073 | 0.118 | 11 |
| 4 | 0.661 | 0.469 | 0.062 | 0.123 | 11 |
| 8 | 0.592 | 0.416 | 0.057 | 0.112 | 11 |

The encoder was the largest measured component. The selected runtime retains four CPU threads and the library encoder context. The bounded scheduler now retains a pending first useful live pass before its final job when capacity permits. Two-pass LocalAgreement and existing confidence filters remain in place.

## Every retained historical run

The inventory includes earlier experiments and all Stage 1 and Stage 3 repeats. Their numbers use matched-reference-word receipt delay. Missing values are unavailable. The original 161088-sample review run lacks per-stage traces and remains unassignable to exact source causes.

| Report | Model | Source | Partial median ms | Partial p95 ms | Final p95 ms | Reported drops across sources |
| --- | --- | --- | --- | --- | --- | --- |
| D:\vinxa\Vinxa\tmp\phase2-latency-base-final.json | base.en | mic | 2125.0 | 2125.0 | 3625.0 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-latency-base-final.json | base.en | system | 1562.5 | 2624.6 | 5023.8 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-latency-final.json | base.en | mic | unavailable | unavailable | 10016.0 | 161088 |
| D:\vinxa\Vinxa\tmp\phase2-latency-final.json | base.en | system | 2422.0 | 4019.0 | 18504.0 | 161088 |
| D:\vinxa\Vinxa\tmp\phase2-latency-initial.json | base.en | mic | 3344.0 | 3344.0 | 10375.0 | 114112 |
| D:\vinxa\Vinxa\tmp\phase2-latency-initial.json | base.en | system | 6968.0 | 8305.9 | 14800.8 | 114112 |
| D:\vinxa\Vinxa\tmp\phase2-latency-short-encoder.json | base.en | mic | unavailable | unavailable | unavailable | 114112 |
| D:\vinxa\Vinxa\tmp\phase2-latency-short-encoder.json | base.en | system | 6359.0 | 6823.4 | 5844.0 | 114112 |
| D:\vinxa\Vinxa\tmp\phase2-latency-tiny.json | tiny.en | mic | unavailable | unavailable | unavailable | 111808 |
| D:\vinxa\Vinxa\tmp\phase2-latency-tiny.json | tiny.en | system | 3031.0 | 4562.4 | 9086.5 | 111808 |
| D:\vinxa\Vinxa\tmp\phase2-latency-window12-threads8.json | base.en | mic | 6735.0 | 6735.0 | 17360.0 | 695808 |
| D:\vinxa\Vinxa\tmp\phase2-latency-window12-threads8.json | base.en | system | 7789.5 | 10892.7 | 21865.7 | 695808 |
| C:\Users\Navya gupta\AppData\Local\Temp\vinxa-phase2-review-d594c38d04c04766b86f0faac8a48824.json | base.en | mic | unavailable | unavailable | 11937.0 | 161088 |
| C:\Users\Navya gupta\AppData\Local\Temp\vinxa-phase2-review-d594c38d04c04766b86f0faac8a48824.json | base.en | system | 4695.5 | 6161.9 | 20206.8 | 161088 |
| D:\vinxa\Vinxa\tmp\phase2-stage1-20261126-235905\run-1.json | base.en | mic | 2687.0 | 2687.0 | 4547.0 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage1-20261126-235905\run-1.json | base.en | system | 1406.0 | 2206.4 | 6407.7 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage1-20261126-235905\run-2.json | base.en | mic | 1687.0 | 1687.0 | 3468.0 | 11840 |
| D:\vinxa\Vinxa\tmp\phase2-stage1-20261126-235905\run-2.json | base.en | system | 1804.5 | 3380.6 | 5595.1 | 11840 |
| D:\vinxa\Vinxa\tmp\phase2-stage1-20261126-235905\run-3.json | base.en | mic | 2406.0 | 2406.0 | 4141.0 | 11840 |
| D:\vinxa\Vinxa\tmp\phase2-stage1-20261126-235905\run-3.json | base.en | system | 1985.0 | 3312.6 | 5498.6 | 11840 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-1.json | base.en | mic | 2531.0 | 2531.0 | 4484.0 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-1.json | base.en | system | 1452.5 | 2503.8 | 5165.1 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-2.json | base.en | mic | 2609.0 | 2609.0 | 4422.0 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-2.json | base.en | system | 1468.5 | 2566.8 | 5182.8 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-3.json | base.en | mic | 2719.0 | 2719.0 | 4531.0 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-3.json | base.en | system | 1500.0 | 2531.0 | 5206.2 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-4.json | base.en | mic | 2672.0 | 2672.0 | 4438.0 | 0 |
| D:\vinxa\Vinxa\tmp\phase2-stage3-20261127-001703\run-4.json | base.en | system | 1445.5 | 2437.8 | 5175.2 | 0 |

## Artifacts

- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/run-1.json
- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/run-2.json
- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/run-3.json
- D:/vinxa/Vinxa/tmp/phase2-final-base-20261127-203828/aggregate.json

Each report contains hardware and package versions, exact input hashes, model/configuration, clock translation, frame counts, numeric sidecar traces, event logs and source-specific distributions. The aggregate retains each run and pooled event-level timing distributions.
