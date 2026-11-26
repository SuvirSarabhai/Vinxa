import { PcmEncoder, parseMicrophoneGain } from '../../shared/pcm'
import { sourceIds } from '../../shared/contracts'

declare const sampleRate: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class CaptureProcessor extends AudioWorkletProcessor {
  private stopped = false
  private outstanding = 0
  private readonly encoder: PcmEncoder

  constructor(options: AudioWorkletNodeOptions = {}) {
    super()
    const source = options.processorOptions?.source ?? sourceIds.mic
    if (source !== sourceIds.mic && source !== sourceIds.system) throw new Error('Unsupported PCM source')
    const micGain = source === sourceIds.mic ? parseMicrophoneGain(options.processorOptions?.micGain) : 1
    this.encoder = new PcmEncoder(sampleRate, source, (frame) => {
      if (this.outstanding >= 4) throw new Error('Audio IPC did not keep up with capture')
      this.outstanding++
      this.port.postMessage({ type: 'frame', frame }, [frame])
    }, micGain)
    this.port.onmessage = ({ data }) => {
      if (data.type === 'ack') this.outstanding--
      if (data.type === 'stop' && !this.stopped) {
        try {
          const paddedSamples = this.encoder.finish()
          this.port.postMessage({ type: 'finished', paddedSamples, levels: this.encoder.levels })
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

registerProcessor('vinxa-capture', CaptureProcessor)
