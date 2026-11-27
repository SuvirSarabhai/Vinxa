import type { CaptureBridge } from '../../shared/contracts'
import { MicrophoneGainError, parseMicrophoneGain } from '../../shared/pcm'
import { sourceIds } from '../../shared/contracts'
import { clockEstimate } from '../../shared/frame-protocol'
import { audioSourceSchema } from '../../shared/schemas'
import workletUrl from './worklet.ts?worker&url'

declare global { interface Window { vinxaCapture: CaptureBridge } }

let stream: MediaStream | undefined
let context: AudioContext | undefined
let input: MediaStreamAudioSourceNode | undefined
let worklet: AudioWorkletNode | undefined
let stopping = false
let finished = false
let started = false
let writes = Promise.resolve()
let errorMessage: string | null = null
let paddedSamples = 0
let rendererFrames = 0
let ipcFrames = 0
let audioToRendererMs = 0
let rendererToMainMs = 0
let clockErrorMs = 0
let sessionStartMs = 0
let firstFrameSample: number | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined

const bridge = window.vinxaCapture
const parameters = new URLSearchParams(globalThis.location?.search ?? '')
const source = audioSourceSchema.parse(parameters.get('source') ?? 'mic')
const unsubscribe = bridge.onStop(() => stop())

function stop(error: string | null = null): void {
  errorMessage ??= error
  if (stopping) return
  stopping = true
  // Stop the device immediately. The worklet flushes only samples already received.
  stream?.getTracks().forEach((track) => track.stop())
  if (started && worklet) {
    worklet.port.postMessage({ type: 'stop' })
    flushTimer = setTimeout(() => { errorMessage ??= 'AudioWorklet stop timed out'; void finish() }, 2000)
  } else if (started) void finish()
}

async function finish(): Promise<void> {
  if (finished) return
  finished = true
  clearTimeout(flushTimer)
  stream?.getTracks().forEach((track) => track.stop())
  navigator.mediaDevices.removeEventListener('devicechange', deviceChanged)
  input?.disconnect()
  worklet?.disconnect()
  worklet?.port.close()
  await context?.close().catch(() => {})
  await writes
  unsubscribe()
  await bridge.finished({ error: errorMessage, paddedSamples: errorMessage ? 0 : paddedSamples })
}

async function deviceChanged(): Promise<void> {
  if (source === 'system') {
    // Hidden documents can be unable to enumerate outputs. Do not wait to stop.
    stop('Audio devices changed during system capture; check Windows default output and repeat the test')
    return
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const id = stream?.getAudioTracks()[0]?.getSettings().deviceId
    if (id && !devices.some((device) => device.kind === 'audioinput' && device.deviceId === id)) {
      stop('Microphone was disconnected')
    }
  } catch { stop('Could not verify audio devices after a device change') }
}

async function start(): Promise<void> {
  try {
    const micGain = source === 'mic' ? parseMicrophoneGain(parameters.get('micGain') ?? undefined) : 1
    console.info('[vinxa-capture] requesting stream')
    stream = source === 'mic'
      ? await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      : await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    console.info('[vinxa-capture] stream acquired')
    // Chromium requires a video source for display capture. Its track is discarded immediately.
    if (source === 'system') stream.getVideoTracks().forEach((track) => track.stop())
    if (stopping) { started = true; await finish(); return }
    const track = stream.getAudioTracks()[0]
    if (!track) {
      errorMessage = `${source === 'mic' ? 'Microphone' : 'System capture'} returned no audio track`
      started = true
      await finish()
      return
    }
    if (track.readyState === 'ended') throw new Error('Capture track has already ended')
    track.addEventListener('ended', () => stop(`${source} audio track ended`), { once: true })
    navigator.mediaDevices.addEventListener('devicechange', deviceChanged)
    context = new AudioContext()
    console.info('[vinxa-capture] loading worklet')
    await context.audioWorklet.addModule(workletUrl)
    if (stopping) { started = true; await finish(); return }
    if (bridge.clockSync) {
      const estimates: ReturnType<typeof clockEstimate>[] = []
      for (let index = 0; index < 3; index++) {
        const sent = performance.now()
        const reply = await bridge.clockSync(sent)
        const estimate = clockEstimate(sent, reply.mainReceiveMs, reply.mainSendMs, performance.now())
        estimates.push(estimate)
        sessionStartMs = reply.sessionStartMs
      }
      const best = estimates.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0]
      rendererToMainMs = best.offsetMs
      clockErrorMs = best.uncertaintyMs
      audioToRendererMs = performance.now() - context.currentTime * 1000
    }
    worklet = new AudioWorkletNode(context, 'vinxa-capture', { processorOptions: { source: sourceIds[source], micGain,
      ...(parameters.get('diagnostics') === '1' ? { diagnostics: true } : {}),
      ...(bridge.clockSync ? { timed: true } : {}) } })
    worklet.onprocessorerror = () => stop(`${source} audio processing failed`)
    worklet.port.onmessage = ({ data }) => {
      if (finished) return
      if (data.diagnostics && data.type !== 'frame') console.info('[vinxa-capture] diagnostics ' +
        JSON.stringify({ ...data.diagnostics, rendererFrames, ipcFrames }))
      if (data.type === 'frame') {
        rendererFrames++
        const receivedFrames = rendererFrames
        const captureTimeMs = data.timing ? data.timing.audioTime * 1000 + audioToRendererMs + rendererToMainMs : undefined
        if (data.timing) firstFrameSample ??= Math.round((captureTimeMs! - sessionStartMs) * 16)
        const observedClockResidualMs = data.timing && context
          ? Math.abs(performance.now() - context.currentTime * 1000 - audioToRendererMs) : 0
        const metadata = data.timing ? {
          sequence: data.timing.sequence, startSample: firstFrameSample! + data.timing.sequence * 1600,
          captureTimeMs, captureErrorMs: data.timing.errorMs + clockErrorMs + observedClockResidualMs, sampleCount: 1600 as const,
          captureKind: 'render-estimate' as const
        } : undefined
        writes = writes.then(async () => {
          if (errorMessage) return
          try {
            ipcFrames++
            if (data.diagnostics) await bridge.frame(data.frame, metadata,
              { ...data.diagnostics, rendererFrames: receivedFrames, ipcFrames })
            else if (metadata) await bridge.frame(data.frame, metadata)
            else await bridge.frame(data.frame)
            worklet?.port.postMessage({ type: 'ack' })
          } catch { stop(`Could not write ${source} audio to disk`) }
        })
      } else if (data.type === 'finished') {
        if (data.levels) {
          console.info('[vinxa-capture] levels ' + JSON.stringify(data.levels))
          if (source === 'mic' && data.levels.inputFullScaleSamples > 0) {
            console.warn('[vinxa-capture] input reached full scale before application gain; lower Windows microphone input volume and repeat. Attenuation cannot restore clipped speech.')
          }
        }
        paddedSamples = data.paddedSamples
        void finish()
      } else if (data.type === 'error') {
        errorMessage ??= 'Audio processing or bounded IPC buffering failed'
        stopping = true
        void finish()
      }
    }
    input = context.createMediaStreamSource(stream)
    input.connect(worklet)
    // The processor outputs silence, keeping the graph active without microphone feedback.
    worklet.connect(context.destination)
    console.info('[vinxa-capture] resuming audio context')
    await context.resume()
    if (bridge.clockSync) audioToRendererMs = performance.now() - context.currentTime * 1000
    console.info('[vinxa-capture] audio context running')
    started = true
    if (stopping) { await finish(); return }
    await bridge.ready()
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    const label = source === 'mic' ? 'Microphone' : 'System audio'
    errorMessage = error instanceof MicrophoneGainError ? error.message : name === 'NotAllowedError' ? `${label} permission was denied`
      : name === 'NotFoundError' ? `No ${source === 'mic' ? 'microphone' : 'system capture device'} is available`
        : `${label} startup failed; check Windows privacy settings and the audio device`
    started = true
    await finish()
  }
}

void start()
