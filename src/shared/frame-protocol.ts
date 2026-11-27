import type { AudioFrameMetadata, AudioSourceName } from './contracts'
import { sourceIds } from './contracts'
import { audioFrameMetadataSchema } from './schemas'

export const timedHeaderBytes = 48

export function encodeTimedFrame(source: AudioSourceName, pcm: Uint8Array,
  metadata: AudioFrameMetadata, sentMs: number): Uint8Array<ArrayBuffer> {
  audioFrameMetadataSchema.parse(metadata)
  if (pcm.byteLength !== 3200 || metadata.sequence === undefined || metadata.captureTimeMs === undefined ||
    metadata.captureErrorMs === undefined || metadata.sampleCount !== 1600 || !Number.isFinite(sentMs)) {
    throw new Error('Timed frames require complete acquisition metadata')
  }
  const output = new Uint8Array(timedHeaderBytes + pcm.byteLength)
  const header = new DataView(output.buffer)
  output.set([86, 88, 2, sourceIds[source]])
  header.setUint32(4, metadata.sequence, true)
  header.setFloat64(8, metadata.startSample, true)
  header.setFloat64(16, metadata.captureTimeMs, true)
  header.setFloat64(24, sentMs, true)
  header.setUint32(32, metadata.sampleCount, true)
  header.setFloat64(36, metadata.captureErrorMs, true)
  header.setUint32(44, metadata.captureKind === 'render-estimate' ? 1 : 0, true)
  output.set(pcm, timedHeaderBytes)
  return output
}

export function clockEstimate(clientSendMs: number, serverReceiveMs: number,
  serverSendMs: number, clientReceiveMs: number): { offsetMs: number; uncertaintyMs: number } {
  const elapsed = clientReceiveMs - clientSendMs
  const serverElapsed = serverSendMs - serverReceiveMs
  if (![clientSendMs, serverReceiveMs, serverSendMs, clientReceiveMs].every(Number.isFinite) ||
    elapsed < 0 || serverElapsed < 0 || serverElapsed > elapsed + 1) throw new Error('Invalid clock exchange')
  return { offsetMs: ((serverReceiveMs - clientSendMs) + (serverSendMs - clientReceiveMs)) / 2,
    uncertaintyMs: Math.max(0, elapsed - serverElapsed) / 2 }
}
