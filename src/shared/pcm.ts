export const pcmFormat = { sampleRate: 16000, channels: 1, frameSamples: 1600, frameBytes: 3200 } as const

export function floatToInt16(sample: number): number {
  if (!Number.isFinite(sample)) throw new Error('PCM samples must be finite')
  const clipped = Math.max(-1, Math.min(1, sample))
  return Math.round(clipped * (clipped < 0 ? 32768 : 32767))
}

/** Streaming windowed-sinc resampler. Retains a bounded ring across render quanta. */
export class PcmEncoder {
  private readonly history = new Float32Array(256)
  private inputSamples = 0
  private outputSamples = 0
  private frame = new ArrayBuffer(pcmFormat.frameBytes + 1)
  private frameOffset = 0
  private ended = false
  private readonly radius = 64

  constructor(private readonly inputRate: number, private readonly source: 0 | 1,
    private readonly emit: (frame: ArrayBuffer) => void) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000) {
      throw new Error('Input sample rate must be between 8000 and 192000 Hz')
    }
    new Uint8Array(this.frame)[0] = source
  }

  push(channels: readonly Float32Array[]): void {
    if (this.ended) throw new Error('PCM encoder already stopped')
    if (!channels.length) return
    const length = channels[0].length
    if (channels.some((channel) => channel.length !== length)) throw new Error('Channel lengths differ')
    for (let index = 0; index < length; index++) {
      let mono = 0
      for (const channel of channels) mono += channel[index] / channels.length
      if (!Number.isFinite(mono)) throw new Error('PCM samples must be finite')
      this.history[this.inputSamples % this.history.length] = mono
      this.inputSamples++
      while (this.outputSamples * this.inputRate / pcmFormat.sampleRate + this.radius < this.inputSamples) {
        this.writeSample(this.interpolate())
      }
    }
  }

  finish(): number {
    if (this.ended) return 0
    this.ended = true
    const count = Math.floor(this.inputSamples * pcmFormat.sampleRate / this.inputRate)
    while (this.outputSamples < count) this.writeSample(this.interpolate())
    const padding = this.frameOffset ? pcmFormat.frameSamples - this.frameOffset : 0
    if (this.frameOffset) this.emit(this.frame)
    return padding
  }

  private interpolate(): number {
    const position = this.outputSamples * this.inputRate / pcmFormat.sampleRate
    const center = Math.floor(position)
    const cutoff = 0.45 * Math.min(1, pcmFormat.sampleRate / this.inputRate)
    let sum = 0
    let weightSum = 0
    for (let index = center - this.radius + 1; index <= center + this.radius; index++) {
      const distance = index - position
      const x = 2 * cutoff * distance
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius)
      const weight = 2 * cutoff * sinc * window
      const sample = index < 0 || index >= this.inputSamples ? 0 : this.history[index % this.history.length]
      sum += sample * weight
      weightSum += weight
    }
    return sum / weightSum
  }

  private writeSample(value: number): void {
    new DataView(this.frame).setInt16(1 + this.frameOffset * 2, floatToInt16(value), true)
    this.frameOffset++
    this.outputSamples++
    if (this.frameOffset === pcmFormat.frameSamples) {
      this.emit(this.frame)
      this.frame = new ArrayBuffer(pcmFormat.frameBytes + 1)
      new Uint8Array(this.frame)[0] = this.source
      this.frameOffset = 0
    }
  }
}

export function validatePcmFrame(frame: unknown, source: number): asserts frame is ArrayBuffer {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength !== pcmFormat.frameBytes + 1) {
    throw new Error('Expected a source byte and exactly 3200 PCM bytes')
  }
  if (new Uint8Array(frame)[0] !== source) throw new Error('Unexpected audio source')
}
