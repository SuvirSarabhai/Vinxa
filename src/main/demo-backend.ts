import type { RecordingBackend } from '../shared/phase2'
import { FixturePlayer } from './fixture-player'

export function createDemoBackend(): RecordingBackend {
  let player: FixturePlayer | undefined
  let finished = false
  let pausedAt: number | undefined
  let pausedTime = 0

  return {
    mode: 'demo',
    async start(config, sessionId, events) {
      player?.stop()
      finished = false
      pausedAt = undefined
      pausedTime = 0
      const segmentStarts = new Map<string, number>()
      player = new FixturePlayer((segment) => {
        if (segment.source === 'mic' ? !config.microphoneEnabled : !config.systemAudioEnabled) return
        if (!segmentStarts.has(segment.id)) segmentStarts.set(segment.id, segment.startMs + pausedTime)
        events.transcript({
          ...segment, meetingId: sessionId,
          startMs: segmentStarts.get(segment.id)!, endMs: segment.endMs + pausedTime
        })
      }, (status) => {
        if (status === 'completed') {
          finished = true
          events.notice('Sample playback finished. Stop ends the demo session; no audio was captured.')
        }
      })
      events.levels(null, null)
      player.play()
    },
    async pause() {
      pausedAt = Date.now()
      player?.pause()
    },
    async resume() {
      if (pausedAt !== undefined) pausedTime += Date.now() - pausedAt
      pausedAt = undefined
      if (!finished) player?.play()
    },
    async stop() {
      player?.stop()
      player = undefined
      pausedAt = undefined
    }
  }
}
