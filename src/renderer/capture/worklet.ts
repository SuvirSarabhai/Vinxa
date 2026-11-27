import { PcmEncoder, parseMicrophoneGain } from '../../shared/pcm'
import { sourceIds } from '../../shared/contracts'

declare const sampleRate: number
declare const currentFrame: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class CaptureProcessor extends AudioWorkletProcessor {
  private stopped = false
  private outstanding = 0
  private producedFrames = 0
  private readonly diagnostics: boolean
  private readonly timed: boolean
  private firstAudioTime: number | undefined
  private nextInputFrame: number | undefined
  private readonly encoder: PcmEncoder

  constructor(options: AudioWorkletNodeOptions = {}) {
    super()
    this.diagnostics = options.processorOptions?.diagnostics === true
    this.timed = options.processorOptions?.timed === true
    const source = options.processorOptions?.source ?? sourceIds.mic
    if (source !== sourceIds.mic && source !== sourceIds.system) throw new Error('Unsupported PCM source')
    const micGain = source === sourceIds.mic ? parseMicrophoneGain(options.processorOptions?.micGain) : 1
    this.encoder = new PcmEncoder(sampleRate, source, (frame) => {
      const sequence = this.producedFrames++
      if (this.outstanding >= 4) throw new Error('Audio IPC did not keep up with capture')
      this.outstanding++
      this.port.postMessage({ type: 'frame', frame,
        ...(this.diagnostics ? { diagnostics: { sequence, producedSamples: this.producedFrames * 1600 } } : {}),
        ...(this.timed ? { timing: { sequence, audioTime: (this.firstAudioTime ?? 0) + sequence / 10,
          sampleCount: 1600, errorMs: 256 / sampleRate * 1000 } } : {}) }, [frame])
    }, micGain)
    this.port.onmessage = ({ data }) => {
      if (data.type === 'ack') this.outstanding--
      if (data.type === 'stop' && !this.stopped) {
        try {
          const paddedSamples = this.encoder.finish()
          this.port.postMessage({ type: 'finished', paddedSamples, levels: this.encoder.levels, ...(this.diagnostics ? { diagnostics: { producedFrames: this.producedFrames, outstanding: this.outstanding } } : {}) })
        } catch {
          this.port.postMessage({ type: 'error', ...(this.diagnostics ? { diagnostics: { producedFrames: this.producedFrames, outstanding: this.outstanding } } : {}) })
        }
        this.stopped = true
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    try {
      const channels = inputs[0] ?? []
      if (this.timed && channels[0]?.length && typeof currentFrame === 'number') {
        if (this.nextInputFrame !== undefined && currentFrame !== this.nextInputFrame) throw new Error('Audio graph sample clock is discontinuous')
        this.firstAudioTime ??= currentFrame / sampleRate
        this.nextInputFrame = currentFrame + channels[0].length
      }
      this.encoder.push(channels)
      return true
    } catch {
      this.stopped = true
      this.port.postMessage({ type: 'error', ...(this.diagnostics ? { diagnostics: { producedFrames: this.producedFrames, outstanding: this.outstanding } } : {}) })
      return false
    }
  }
}

registerProcessor('vinxa-capture', CaptureProcessor)
