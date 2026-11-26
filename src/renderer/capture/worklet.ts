import { PcmEncoder } from '../../shared/pcm'
import { sourceIds } from '../../shared/contracts'

declare const sampleRate: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class MicrophoneProcessor extends AudioWorkletProcessor {
  private stopped = false
  private outstanding = 0
  private readonly encoder = new PcmEncoder(sampleRate, sourceIds.mic, (frame) => {
    if (this.outstanding >= 4) throw new Error('Audio IPC did not keep up with capture')
    this.outstanding++
    this.port.postMessage({ type: 'frame', frame }, [frame])
  })

  constructor() {
    super()
    this.port.onmessage = ({ data }) => {
      if (data.type === 'ack') this.outstanding--
      if (data.type === 'stop' && !this.stopped) {
        try {
          const paddedSamples = this.encoder.finish()
          this.port.postMessage({ type: 'finished', paddedSamples })
        } catch {
          this.port.postMessage({ type: 'error' })
        }
        this.stopped = true
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    try {
      this.encoder.push(inputs[0] ?? [])
      return true
    } catch {
      this.stopped = true
      this.port.postMessage({ type: 'error' })
      return false
    }
  }
}

registerProcessor('vinxa-microphone', MicrophoneProcessor)
