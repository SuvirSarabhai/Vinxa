import asyncio
import json
import secrets
from time import perf_counter
import uuid

import pytest
from websockets.asyncio.client import connect

from sidecar.protocol import ProtocolError, pack_timed_frame, parse_frame
from sidecar.server import SidecarServer
from sidecar.streaming import StreamingPipeline
from sidecar.test_runtime import until
from sidecar.test_server import config, control
from sidecar.test_streaming import Engine, EnergyScore
from sidecar.session import Session
from sidecar.streaming import Job, Utterance
from sidecar.local_agreement import LocalAgreement
from sidecar.scheduling import FairQueue
import numpy as np


def test_timed_header_round_trip_legacy_and_invalid_values():
    packet = pack_timed_frame(1, bytes(3200), 7, 11200, 1234.5, 1334.5, 0.25)
    result = parse_frame(packet, ['system'], 2)
    assert result.metadata['sequence'] == 7
    assert result.metadata['startSample'] == 11200
    assert result.metadata['captureTimeMs'] == 1234.5
    assert result.pcm == bytes(3200)
    assert parse_frame(b'\0' + bytes(3200), ['mic']).metadata is None
    with pytest.raises(ProtocolError):
        parse_frame(packet, ['system'])
    with pytest.raises(ProtocolError):
        parse_frame(pack_timed_frame(1, bytes(3200), 7, 0, float('nan'), 0), ['system'], 2)


def test_warm_model_reused_across_fresh_sessions_and_frame_timing_survives():
    async def run():
        token, engine, events = secrets.token_hex(32), Engine(), []
        def factory(configuration, emit):
            async def capture(event):
                events.append(event)
                await emit(event)
            return StreamingPipeline(configuration, capture, engine=engine, scorer_factory=EnergyScore)
        async with SidecarServer(token, str(uuid.uuid4()), 0, pipeline_factory=factory) as server:
            async with connect(f'ws://127.0.0.1:{server.port}', proxy=None) as socket:
                setup = {**config(server, token), 'protocolVersion': 2, 'timedFrames': True,
                         'keepAlive': True, 'standby': True}
                await socket.send(json.dumps(setup))
                await until(socket, lambda e: e.get('status') == 'ready')
                assert engine.loads == engine.warmups == 1
                sync = control(server, 'clock-sync', clientSendMs=perf_counter() * 1000)
                await socket.send(json.dumps(sync))
                reply = await until(socket, lambda e: e.get('requestId') == sync['requestId'])
                assert reply['clock']['serverSendMs'] >= reply['clock']['serverReceiveMs']
                clock = control(server, 'clock-set', offsetMs=0, uncertaintyMs=0.1)
                await socket.send(json.dumps(clock))
                await until(socket, lambda e: e.get('requestId') == clock['requestId'])
                identities = []
                for _ in range(2):
                    next_id = str(uuid.uuid4())
                    identities.append(next_id)
                    begin = control(server, 'session-begin', nextSessionId=next_id,
                                    language='en', enabledSources=['mic', 'system'])
                    await socket.send(json.dumps(begin))
                    await until(socket, lambda e: e.get('requestId') == begin['requestId'])
                    assert not any(s.buffer.end for s in server.pipeline.sources.values())
                    anchor = control(server, 'source-start', source='mic', startSample=0)
                    await socket.send(json.dumps(anchor))
                    await until(socket, lambda e: e.get('requestId') == anchor['requestId'])
                    epoch = perf_counter() * 1000
                    for index in range(24):
                        await socket.send(pack_timed_frame(0, b'\0\x10' * 1600, index,
                            index * 1600, epoch + index * 100, perf_counter() * 1000))
                        await asyncio.sleep(0.002)
                    end = control(server, 'session-end')
                    await socket.send(json.dumps(end))
                    await until(socket, lambda e: e.get('requestId') == end['requestId'])
                    assert server.pipeline.closed
                    assert engine.loads == engine.warmups == 1
                texts = [e for e in events if e['type'] in ('partial', 'final') and e['text']]
                assert {e['sessionId'] for e in texts} == set(identities)
                assert all('timing' in e for e in texts)
                assert all(e['timing']['lastSequence'] >= e['timing']['firstSequence'] for e in texts)
                await socket.send(json.dumps(control(server, 'stop')))
                await until(socket, lambda e: e.get('status') == 'stopped')
    asyncio.run(run())


def test_first_live_snapshot_is_retained_before_its_final_within_the_queue_bound():
    async def run():
        queue = FairQueue(['mic'], 2)
        utterance = Utterance('mic', 1, 0, 0, LocalAgreement())
        live = Job(utterance, np.zeros(1600), 0, 1600, False)
        final = Job(utterance, np.zeros(3200), 0, 3200, True)
        assert queue.put(live) and queue.put(final)
        assert queue.depth == 2
        assert await queue.get() is live
        assert await queue.get() is final
        queue.close()
    asyncio.run(run())


def test_persistent_health_history_is_bounded_and_recent_duplicate_requests_are_rejected():
    identity = str(uuid.uuid4())
    session = Session(identity, 0, ('mic',), persistent=True)
    last = None
    for _ in range(4100):
        last = dict(type='ping', sessionId=identity, generation=0, requestId=str(uuid.uuid4()))
        session.accept_control(last)
    assert len(session._requests) == len(session._request_order) == 4096
    with pytest.raises(ProtocolError):
        session.accept_control(last)


def test_timed_sequence_replay_is_rejected_without_counting_input_twice():
    async def run():
        async def emit(event):
            pass
        pipeline = StreamingPipeline(dict(model='base.en', language='en', generation=0,
            sessionId=str(uuid.uuid4()), enabledSources=['mic']), emit, engine=Engine(), scorer_factory=EnergyScore)
        try:
            await pipeline.start()
            await pipeline.anchor('mic', 0)
            first = parse_frame(pack_timed_frame(0, bytes(3200), 0, 0, 0, 100), ['mic'], 2)
            await pipeline.ingest(first)
            duplicate = parse_frame(pack_timed_frame(0, bytes(3200), 0, 1600, 100, 200), ['mic'], 2)
            with pytest.raises(ProtocolError):
                await pipeline.ingest(duplicate)
            assert pipeline.sources['mic'].accounting.received == 1600
            await pipeline.stop()
        finally:
            await pipeline.close()
    asyncio.run(run())
