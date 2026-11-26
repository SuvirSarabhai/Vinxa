import { open, mkdir, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pcmFormat, validatePcmFrame } from '../../shared/pcm'

const reserveBytes = 16 * 1024 * 1024

export function wavHeader(bytes: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(pcmFormat.sampleRate, 24)
  header.writeUInt32LE(pcmFormat.sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)
  return header
}

export class WavWriter {
  private bytes = 0
  private closed = false
  private queue = Promise.resolve()
  private pending = 0

  private constructor(private readonly file: FileHandle, private readonly path: string) {}

  static async create(path: string): Promise<WavWriter> {
    await mkdir(dirname(path), { recursive: true })
    const space = await statfs(dirname(path))
    if (space.bavail * space.bsize < reserveBytes) throw new Error('Insufficient disk space for recording')
    const file = await open(path, 'wx')
    try {
      await file.writeFile(wavHeader(0))
      return new WavWriter(file, path)
    } catch (error) {
      await file.close()
      throw error
    }
  }

  append(frame: ArrayBuffer): Promise<void> {
    validatePcmFrame(frame, 0)
    if (this.closed) return Promise.reject(new Error('WAV writer is closed'))
    if (this.pending >= 4) return Promise.reject(new Error('Audio writer buffer is full'))
    this.pending++
    const write = this.queue.then(async () => {
      if (this.bytes + pcmFormat.frameBytes > 0xffffffff - 36) throw new Error('WAV size limit reached')
      if (this.bytes % (pcmFormat.frameBytes * 50) === 0) {
        const space = await statfs(dirname(this.path))
        if (space.bavail * space.bsize < reserveBytes) throw new Error('Recording stopped because disk space is low')
      }
      const data = Buffer.from(frame, 1)
      let offset = 0
      try {
        while (offset < data.length) {
          const result = await this.file.write(data, offset, data.length - offset, 44 + this.bytes)
          if (!result.bytesWritten) throw new Error('Audio file write made no progress')
          offset += result.bytesWritten
          this.bytes += result.bytesWritten
        }
      } finally {
        // Refresh after every frame so an interrupted renderer leaves a recoverable header.
        await this.file.write(wavHeader(this.bytes - this.bytes % 2), 0, 44, 0)
      }
    })
    this.queue = write.catch(() => {})
    return write.finally(() => { this.pending-- })
  }

  async close(paddedSamples = 0): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.queue
    try {
      this.bytes = Math.max(0, this.bytes - paddedSamples * 2)
      this.bytes -= this.bytes % 2
      await this.file.truncate(44 + this.bytes)
      await this.file.write(wavHeader(this.bytes), 0, 44, 0)
      await this.file.sync()
    } finally {
      await this.file.close()
    }
  }
}
