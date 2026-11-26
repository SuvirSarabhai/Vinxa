import type { CaptureBridge } from '../../shared/contracts'
import { sourceIds } from '../../shared/contracts'
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
let flushTimer: ReturnType<typeof setTimeout> | undefined

const bridge = window.vinxaCapture
const source = audioSourceSchema.parse(new URLSearchParams(globalThis.location?.search ?? '').get('source') ?? 'mic')
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
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const id = stream?.getAudioTracks()[0]?.getSettings().deviceId
    if (source === 'system') {
      stop('Audio devices changed during system capture; check Windows default output and repeat the test')
    } else if (id && !devices.some((device) => device.kind === 'audioinput' && device.deviceId === id)) {
      stop('Microphone was disconnected')
    }
  } catch { stop('Could not verify audio devices after a device change') }
}

async function start(): Promise<void> {
  try {
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
    worklet = new AudioWorkletNode(context, 'vinxa-capture', { processorOptions: { source: sourceIds[source] } })
    worklet.onprocessorerror = () => stop(`${source} audio processing failed`)
    worklet.port.onmessage = ({ data }) => {
      if (finished) return
      if (data.type === 'frame') {
        writes = writes.then(async () => {
          if (errorMessage) return
          try {
            await bridge.frame(data.frame)
            worklet?.port.postMessage({ type: 'ack' })
          } catch { stop(`Could not write ${source} audio to disk`) }
        })
      } else if (data.type === 'finished') {
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
    console.info('[vinxa-capture] audio context running')
    started = true
    if (stopping) { await finish(); return }
    await bridge.ready()
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    const label = source === 'mic' ? 'Microphone' : 'System audio'
    errorMessage = name === 'NotAllowedError' ? `${label} permission was denied`
      : name === 'NotFoundError' ? `No ${source === 'mic' ? 'microphone' : 'system capture device'} is available`
        : `${label} startup failed; check Windows privacy settings and the audio device`
    started = true
    await finish()
  }
}

void start()
