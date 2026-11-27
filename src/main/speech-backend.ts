import type { BrowserWindow } from 'electron'
import type { RecordingConfig, AudioSourceName } from '../shared/contracts'
import type { BackendEvents, RecordingBackend, RecordingEngine } from '../shared/phase2'
import type { RecordingOwner, RecordingSpeechBridge } from './recording-speech-bridge'
import { getAppSpeech } from './speech-service'
import type { SpeechServiceEvent } from './speech-service'
import { RecordingCapture } from './audio/recording-capture'
import { speechDiagnostics } from './speech-diagnostics'

export function createSpeechBackend(window: BrowserWindow): RecordingBackend {
  const speech = getAppSpeech()
  let owner: RecordingOwner | undefined
  let bridge: RecordingSpeechBridge | undefined
  let capture: RecordingCapture | undefined
  let callbacks: BackendEvents | undefined
  let sessionId: string | undefined
  let sessionEpochMs = 0
  let active = false
  let paused = false
  let lastGeneration: number | undefined
  const listeners = new Set<(engine: RecordingEngine) => void>()
  let engine: RecordingEngine = { ready: speech?.manager.ready ?? false,
    message: speech ? 'Loading and warming the cached local speech model…' : 'Local speech is unavailable. Check the Python runtime and cached model, then restart Vinxa.' }

  const setEngine = (next: RecordingEngine): void => {
    engine = next
    listeners.forEach((listener) => listener({ ...engine }))
  }
  const fail = (message: string): void => {
    if (!active) return
    active = false
    void capture?.abort().catch(() => undefined)
    callbacks?.discardPartials?.()
    callbacks?.failure(message)
  }
  const receive = (event: SpeechServiceEvent): void => {
    if (event.type === 'status') {
      const ready = speech?.manager.ready ?? false
      setEngine({ ready, message: ready ? 'Local speech is ready. Audio is processed on this laptop.'
        : event.status === 'error' ? 'Local speech failed. Check the runtime/model and restart Vinxa.'
          : event.status === 'restarting' ? 'Restarting local speech. Some unfinalized words may be missing.'
            : 'Loading and warming the cached local speech model…' })
      if (active && (event.status === 'restarting' || (lastGeneration !== undefined && lastGeneration !== event.generation))) {
        callbacks?.discardPartials?.()
        callbacks?.notice('Local speech restarted. Final text is retained; interrupted provisional words may be missing.')
      }
      lastGeneration = event.generation
      if (event.metrics?.droppedSamples) callbacks?.notice(`Speech processing reported ${event.metrics.droppedSamples} dropped audio samples. Check system load and the selected model.`)
      if (event.status === 'error') fail('Local speech is unavailable. Capture has stopped; restart Vinxa after checking the runtime.')
    } else if (event.type === 'error') {
      if (event.code === 'DIAGNOSTICS_FAILED') callbacks?.notice(event.message)
      else if (!event.recoverable) fail(event.message)
      else { callbacks?.notice(event.message); if (event.code === 'SIDECAR_DISCONNECTED') callbacks?.discardPartials?.() }
    } else if (active && event.segment.meetingId === sessionId) {
      speechDiagnostics.record('transcript_received', event.segment.source, 0, {
        startMs: event.segment.startMs, endMs: event.segment.endMs,
        final: event.segment.isFinal ? 1 : 0,
        wordAgeMs: Math.max(0, performance.now() - sessionEpochMs - event.segment.endMs)
      })
      callbacks?.transcript({ ...event.segment, speakerId: event.segment.source === 'mic' ? 'you' : 'remote' })
    }
  }
  const unsubscribe = speech?.subscribe(receive)

  async function finishSources(): Promise<void> {
    if (!capture || !bridge || !sessionId) return
    for (const [source, padding] of Object.entries(capture.finalPadding)) {
      await bridge.sourceEnd(sessionId, source as AudioSourceName, padding!)
    }
  }

  return {
    mode: 'local',
    bindOwner: (value) => { owner = value },
    onEngine(listener) { listeners.add(listener); listener({ ...engine }); return () => listeners.delete(listener) },
    async start(config: RecordingConfig, id: string, events: BackendEvents, sessionStartMs = performance.now()) {
      if (capture || bridge || active) throw new Error('A live session is already present.')
      if (!speech || !owner || !owner.hasConsent(id) || !speech.manager.ready) throw new Error(engine.message)
      callbacks = events
      sessionId = id
      sessionEpochMs = sessionStartMs
      active = true
      paused = false
      bridge = speech.createBridge(owner, window)
      const levels: Record<AudioSourceName, number | null> = { mic: null, system: null }
      capture = new RecordingCapture((source, pcm, metadata) => {
        if (!active || !bridge?.frame(id, source, pcm, metadata)) throw new Error('Speech rejected an audio frame.')
      }, (source, value) => {
        levels[source] = value
        events.levels(levels.mic, levels.system)
      }, fail)
      try {
        await bridge.start({ sessionId: id, meetingId: id, model: speech.selectedModel,
          language: speech.selectedLanguage, enabledSources: [
            ...(config.microphoneEnabled ? ['mic' as const] : []), ...(config.systemAudioEnabled ? ['system' as const] : [])
          ] })
        await capture.start(config, sessionStartMs)
        events.notice('Live local transcription. Meeting-app mute does not mute Vinxa. Raw audio is not saved in this mode.')
      } catch (error) {
        active = false
        await capture.abort().catch(() => undefined)
        await bridge.stop().catch(() => undefined)
        capture = undefined; bridge = undefined; callbacks = undefined; sessionId = undefined
        throw error
      }
    },
    async pause() {
      if (!active || !capture || !bridge || !sessionId) throw new Error('No live recording is active.')
      await capture.stop()
      await finishSources()
      await bridge.pause(sessionId)
      paused = true
      callbacks?.levels(null, null)
    },
    async resume() {
      if (!active || !paused || !capture || !bridge || !sessionId) throw new Error('No paused recording is active.')
      await bridge.resume(sessionId)
      await capture.resume()
      paused = false
    },
    async stop() {
      try {
        if (active && capture && bridge && sessionId && !paused) {
          bridge.beginDrain(sessionId)
          await capture.stop()
          await finishSources()
        }
      } finally {
        try { await bridge?.stop() }
        finally {
          active = false
          await capture?.abort().catch(() => undefined)
          callbacks?.levels(null, null)
          capture = undefined; bridge = undefined; callbacks = undefined; sessionId = undefined; paused = false
        }
      }
    },
    dispose() { unsubscribe?.(); listeners.clear() }
  }
}
