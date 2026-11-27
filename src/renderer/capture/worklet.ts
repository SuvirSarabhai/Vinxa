import { PcmEncoder, parseMicrophoneGain } from '../../shared/pcm'
import type { PcmLevels } from '../../shared/pcm'
import { sourceIds } from '../../shared/contracts'

declare const sampleRate: number
declare const currentFrame: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

// Bound memory while allowing a brief main-process stall during window creation.
// Flush may emit a resampler tail plus one padded packet after capture stops.
export const captureQueueLimit = 12
const flushReserve = 2

class CaptureProcessor extends AudioWorkletProcessor {
  private stopped = false
  private flushing = false
  private outstanding = 0
  private producedFrames = 0
  private readonly diagnostics: boolean
  private readonly timed: boolean
  private firstAudioTime: number | undefined
  private segmentFirstFrame = 0
  private nextInputFrame: number | undefined
  private readonly silence = new Float32Array(128)
  private readonly source: 0 | 1
  private readonly micGain: number
  private encoder: PcmEncoder
  private previousLevels: Readonly<PcmLevels> | undefined

  constructor(options: AudioWorkletNodeOptions = {}) {
    super()
    this.diagnostics = options.processorOptions?.diagnostics === true
    this.timed = options.processorOptions?.timed === true
    this.source = options.processorOptions?.source ?? sourceIds.mic
    if (this.source !== sourceIds.mic && this.source !== sourceIds.system) throw new Error('Unsupported PCM source')
    this.micGain = this.source === sourceIds.mic ? parseMicrophoneGain(options.processorOptions?.micGain) : 1
    this.encoder = this.createEncoder()
    this.port.onmessage = ({ data }) => {
      if (data.type === 'ack') this.outstanding = Math.max(0, this.outstanding - 1)
      if (data.type === 'stop' && !this.stopped) {
        try {
          this.flushing = true
          const paddedSamples = this.encoder.finish()
          this.port.postMessage({ type: 'finished', paddedSamples, levels: this.levels(), ...(this.diagnostics ? { diagnostics: { producedFrames: this.producedFrames, outstanding: this.outstanding } } : {}) })
        } catch (error) {
          this.reportError(error)
        }
        this.stopped = true
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][] = []): boolean {
    if (this.stopped) return false
    try {
      let channels = inputs[0] ?? []
      // An empty input is a valid graph quantum (including during track mute).
      // Once anchored, account for it as silence so the next real input retains
      // the same sample clock instead of being mistaken for a transport error.
      if (!channels[0]?.length) {
        if (this.firstAudioTime === undefined) return true
        const length = outputs[0]?.[0]?.length ?? 128
        channels = [length === this.silence.length ? this.silence : new Float32Array(length)]
      }
      if (this.timed && channels[0]?.length && typeof currentFrame === 'number') {
        if (!Number.isSafeInteger(currentFrame) || currentFrame < 0 ||
          (this.nextInputFrame !== undefined && currentFrame < this.nextInputFrame)) throw new Error('AUDIO_CLOCK_RESET')
        if (this.nextInputFrame !== undefined && currentFrame > this.nextInputFrame) this.recoverGap(currentFrame - this.nextInputFrame)
        this.firstAudioTime ??= currentFrame / sampleRate
        this.nextInputFrame = currentFrame + channels[0].length
      }
      this.encoder.push(channels)
      return true
    } catch (error) {
      this.stopped = true
      this.reportError(error)
      return false
    }
  }

  private createEncoder(): PcmEncoder {
    return new PcmEncoder(sampleRate, this.source, (frame) => {
      if (this.outstanding >= captureQueueLimit + (this.flushing ? flushReserve : 0)) throw new Error('PCM_QUEUE_FULL')
      const sequence = this.producedFrames++
      this.outstanding++
      this.port.postMessage({ type: 'frame', frame,
        ...(this.diagnostics ? { diagnostics: { sequence, producedSamples: this.producedFrames * 1600 } } : {}),
        ...(this.timed ? { timing: { sequence,
          audioTime: (this.firstAudioTime ?? 0) + (sequence - this.segmentFirstFrame) / 10,
          sampleCount: 1600, errorMs: 256 / sampleRate * 1000 } } : {}) }, [frame])
    }, this.micGain)
  }

  private recoverGap(missingInputFrames: number): void {
    if (missingInputFrames <= sampleRate / 4) {
      // Keep short gaps on the existing timeline. Work is bounded to 250 ms;
      // missing input is silence, never a repeat of earlier microphone audio.
      for (let remaining = missingInputFrames; remaining > 0; remaining -= this.silence.length) {
        this.encoder.push([remaining >= this.silence.length ? this.silence : this.silence.subarray(0, remaining)])
      }
    } else {
      // Do not synthesize seconds/minutes of audio after a graph interruption.
      // Flush the old packet, then anchor the new encoder at the actual graph
      // time. The existing source-gap protocol reports the missing interval.
      this.flushing = true
      this.encoder.finish()
      this.flushing = false
      this.previousLevels = this.levels()
      this.encoder = this.createEncoder()
      this.segmentFirstFrame = this.producedFrames
      this.firstAudioTime = currentFrame / sampleRate
    }
    this.port.postMessage({ type: 'gap', missingInputFrames, sampleRate,
      recovery: missingInputFrames <= sampleRate / 4 ? 'silence' : 'reanchor' })
  }

  private levels(): Readonly<PcmLevels> {
    const current = this.encoder.levels
    const previous = this.previousLevels
    if (!previous) return current
    return { gain: current.gain,
      inputSamples: previous.inputSamples + current.inputSamples,
      inputPeak: Math.max(previous.inputPeak, current.inputPeak),
      inputFullScaleSamples: previous.inputFullScaleSamples + current.inputFullScaleSamples,
      preGainSamples: previous.preGainSamples + current.preGainSamples,
      preGainPeak: Math.max(previous.preGainPeak, current.preGainPeak),
      preGainFullScaleSamples: previous.preGainFullScaleSamples + current.preGainFullScaleSamples,
      outputFullScaleSamples: previous.outputFullScaleSamples + current.outputFullScaleSamples }
  }

  private reportError(error: unknown): void {
    const code = error instanceof Error && ['PCM_QUEUE_FULL', 'AUDIO_CLOCK_RESET'].includes(error.message)
      ? error.message : 'INVALID_PCM'
    this.port.postMessage({ type: 'error', code,
      ...(code === 'AUDIO_CLOCK_RESET' && this.nextInputFrame !== undefined && Number.isFinite(currentFrame)
        ? { clock: { expectedFrame: this.nextInputFrame, observedFrame: currentFrame, sampleRate } } : {}),
      ...(this.diagnostics ? { diagnostics: {
        producedFrames: this.producedFrames, outstanding: this.outstanding
      } } : {}) })
  }
}

registerProcessor('vinxa-capture', CaptureProcessor)
