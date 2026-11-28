import { mkdir, open, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { wavHeader } from './wav-writer'
import { meetingIdSchema } from '../../shared/meetings'
import type { AudioSpooler } from '../../shared/meetings'
import type { AudioFrameMetadata, AudioSourceName, RecordingConfig } from '../../shared/contracts'
import { audioFrameMetadataSchema, recordingConfigSchema } from '../../shared/schemas'

interface Output {
  file: FileHandle
  path: string
  samples: number
  capturedSamples: number
  tail: Promise<void>
  failure?: Error
}
export class MeetingAudioSpool implements AudioSpooler {
  private outputs = new Map<AudioSourceName, Output>()
  private closing?: Promise<{ microphoneAudioPath: string | null; systemAudioPath: string | null }>
  private constructor(readonly directory: string) {}
  static async create(userData: string, id: string, config: RecordingConfig): Promise<MeetingAudioSpool> {
    meetingIdSchema.parse(id)
    recordingConfigSchema.parse(config)
    const directory = join(userData, 'meetings', id)
    await mkdir(join(userData, 'meetings'), { recursive: true })
    await mkdir(directory)
    const spool = new MeetingAudioSpool(directory)
    try {
      for (const source of ['mic', 'system'] as const) {
        if (!(source === 'mic' ? config.microphoneEnabled : config.systemAudioEnabled)) continue
        const path = join(directory, source === 'mic' ? 'microphone.wav' : 'system.wav')
        const file = await open(path, 'wx')
        spool.outputs.set(source, { file, path, samples: 0, capturedSamples: 0, tail: Promise.resolve() })
        await file.writeFile(wavHeader(0))
      }
      return spool
    } catch (error) {
      await spool.finalize().catch(() => undefined)
      throw error
    }
  }
  get paths() {
    return { microphoneAudioPath: this.outputs.get('mic')?.path ?? null, systemAudioPath: this.outputs.get('system')?.path ?? null }
  }
  append(source: AudioSourceName, pcm: Uint8Array, input: AudioFrameMetadata): Promise<void> {
    const metadata = audioFrameMetadataSchema.parse(input)
    if (pcm.byteLength !== 3200) return Promise.reject(new Error('Expected a 100 ms PCM frame.'))
    const data = Buffer.from(pcm)
    return this.enqueue(source, async output => {
      if (metadata.startSample < output.samples) throw new Error('Overlapping audio frame.')
      const endSample = metadata.startSample + data.length / 2
      if (endSample * 2 > 0xffffffff - 36) throw new Error('WAV size limit reached.')
      let offset = 0
      while (offset < data.length) {
        const written = await output.file.write(data, offset, data.length - offset, 44 + metadata.startSample * 2 + offset)
        if (!written.bytesWritten) throw new Error('Audio file write made no progress.')
        offset += written.bytesWritten
      }
      // Positional writes preserve initial delay and pause gaps as zero-filled PCM.
      output.samples = endSample
      output.capturedSamples += data.length / 2
    })
  }
  endSource(source: AudioSourceName, padding: number): Promise<void> {
    z.number().int().min(0).max(1599).parse(padding)
    return this.enqueue(source, async output => {
      output.samples = Math.max(0, output.samples - padding)
      output.capturedSamples = Math.max(0, output.capturedSamples - padding)
      await output.file.truncate(44 + output.samples * 2)
    })
  }
  private enqueue(source: AudioSourceName, operation: (output: Output) => Promise<void>): Promise<void> {
    const output = this.outputs.get(source)
    if (!output || this.closing) return Promise.reject(new Error('Audio spool is unavailable.'))
    const result = output.tail.then(async () => {
      if (output.failure) throw output.failure
      await operation(output)
    })
    output.tail = result.catch(error => { output.failure ??= error instanceof Error ? error : new Error('Audio write failed.') })
    return result
  }
  finalize(): Promise<{ microphoneAudioPath: string | null; systemAudioPath: string | null }> {
    this.closing ??= this.finish()
    return this.closing
  }
  private async finish() {
    const outcomes = await Promise.allSettled([...this.outputs.values()].map(async output => {
      await output.tail
      try {
        // On write failure, preserve all complete samples that reached the file.
        const bytes = Math.max(0, (await output.file.stat()).size - 44)
        output.samples = Math.floor(bytes / 2)
        await output.file.truncate(44 + output.samples * 2)
        const header = wavHeader(output.samples * 2)
        let offset = 0
        while (offset < header.length) {
          const result = await output.file.write(header, offset, header.length - offset, offset)
          if (!result.bytesWritten) throw new Error('Could not finalize WAV header.')
          offset += result.bytesWritten
        }
        await output.file.sync()
        if (output.failure) throw output.failure
      } finally { await output.file.close() }
    }))
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    await writeFile(join(this.directory, 'metadata.json'), JSON.stringify({
      sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', finalized: !failure,
      sources: Object.fromEntries([...this.outputs].map(([source, output]) => [source, {
        file: source === 'mic' ? 'microphone.wav' : 'system.wav', samples: output.samples, capturedSamples: output.capturedSamples
      }]))
    }, null, 2), { flag: 'wx' })
    if (failure?.status === 'rejected') throw failure.reason
    return this.paths
  }
}
