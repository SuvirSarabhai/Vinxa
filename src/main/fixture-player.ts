import type { FixtureStatus, TranscriptSegment } from '../shared/contracts'
import { transcriptSegmentSchema } from '../shared/schemas'

const fixture = [
  { atMs: 300, id: 'one', source: 'mic', text: 'Let us review', startMs: 0, endMs: 700, isFinal: false },
  { atMs: 1500, id: 'one', source: 'mic', text: 'Let us review the launch plan.', startMs: 0, endMs: 1400, isFinal: true },
  { atMs: 2400, id: 'two', source: 'system', text: 'The backend will be ready', startMs: 1700, endMs: 2400, isFinal: false },
  { atMs: 3600, id: 'two', source: 'system', text: 'The backend will be ready by Friday.', startMs: 1700, endMs: 3500, isFinal: true },
  { atMs: 4500, id: 'three', source: 'mic', text: 'I will handle frontend integration.', startMs: 3800, endMs: 4400, isFinal: true }
].map(({ atMs, ...segment }) => ({
  atMs,
  segment: transcriptSegmentSchema.parse({
    ...segment, meetingId: 'fixture-meeting', speakerId: segment.source === 'mic' ? 'you' : 'remote'
  })
}))

export class FixturePlayer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private cursor = 0
  private elapsed = 0
  private startedAt = 0
  private status: FixtureStatus = 'idle'

  constructor(
    private readonly emit: (segment: TranscriptSegment) => void,
    private readonly onStatus: (status: FixtureStatus) => void
  ) {}

  play(): void {
    if (this.status === 'playing') return
    if (this.status !== 'paused') { this.cursor = 0; this.elapsed = 0 }
    this.startedAt = Date.now() - this.elapsed
    this.setStatus('playing')
    this.schedule()
  }

  pause(): void {
    if (this.status !== 'playing') return
    clearTimeout(this.timer)
    this.elapsed = Date.now() - this.startedAt
    this.setStatus('paused')
  }

  stop(): void {
    clearTimeout(this.timer)
    this.cursor = 0
    this.elapsed = 0
    this.setStatus('idle')
  }

  private setStatus(status: FixtureStatus): void {
    this.status = status
    this.onStatus(status)
  }

  private schedule(): void {
    const next = fixture[this.cursor]
    if (!next) { this.setStatus('completed'); return }
    this.timer = setTimeout(() => {
      this.emit({ ...next.segment })
      this.cursor += 1
      this.schedule()
    }, Math.max(0, next.atMs - (Date.now() - this.startedAt)))
  }
}
