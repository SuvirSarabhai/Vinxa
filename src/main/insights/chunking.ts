import type { TranscriptSegment } from '../../shared/contracts'
import { transcriptSegmentSchema } from '../../shared/schemas'
export function transcriptChunks(input: TranscriptSegment[], maximum: number): string[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid notes chunk size.')
  const segments = input.map(value => transcriptSegmentSchema.parse(value)).sort((a,b) => a.startMs-b.startMs || a.endMs-b.endMs || a.id.localeCompare(b.id))
  if (segments.some(segment => !segment.isFinal)) throw new Error('Notes require a fully finalized transcript.')
  const chunks: string[] = []
  let lines: string[] = [], size = 0
  for (const segment of segments) {
    if (!segment.text.trim()) continue
    const line = JSON.stringify({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, source: segment.source,
      speaker: segment.source === 'mic' ? 'You' : 'Remote', text: segment.text })
    if (lines.length && size + line.length + 1 > maximum) { chunks.push(lines.join('\n')); lines = []; size = 0 }
    lines.push(line); size += line.length + 1
  }
  if (lines.length) chunks.push(lines.join('\n'))
  return chunks
}
