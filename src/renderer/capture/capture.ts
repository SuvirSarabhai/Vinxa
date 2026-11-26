import type { CaptureBridge } from '../../shared/contracts'
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
    if (id && !devices.some((device) => device.kind === 'audioinput' && device.deviceId === id)) {
      stop('Microphone was disconnected')
    }
  } catch { stop('Could not verify microphone after a device change') }
}

async function start(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    if (stopping) { started = true; await finish(); return }
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('Microphone returned no audio track')
    track.addEventListener('ended', () => stop('Microphone track ended'), { once: true })
    navigator.mediaDevices.addEventListener('devicechange', deviceChanged)
    context = new AudioContext()
    await context.audioWorklet.addModule(workletUrl)
    if (stopping) { started = true; await finish(); return }
    worklet = new AudioWorkletNode(context, 'vinxa-microphone')
    worklet.onprocessorerror = () => stop('Microphone audio processing failed')
    worklet.port.onmessage = ({ data }) => {
      if (finished) return
      if (data.type === 'frame') {
        writes = writes.then(async () => {
          if (errorMessage) return
          try {
            await bridge.frame(data.frame)
            worklet?.port.postMessage({ type: 'ack' })
          } catch { stop('Could not write microphone audio to disk') }
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
    await context.resume()
    started = true
    if (stopping) { await finish(); return }
    await bridge.ready()
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    errorMessage = name === 'NotAllowedError' ? 'Microphone permission was denied'
      : name === 'NotFoundError' ? 'No microphone is available'
        : 'Microphone startup failed; check Windows privacy settings and the audio device'
    started = true
    await finish()
  }
}

void start()
