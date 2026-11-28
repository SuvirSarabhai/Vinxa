import type { TranscriptSegment } from './contracts'
export function transcriptSpeaker(segment: TranscriptSegment, names: { mic: string; system: string }): string {
  return segment.source === 'system' && /^Remote [1-9][0-9]*$/.test(segment.speakerId ?? '') ? segment.speakerId! : names[segment.source]
}
