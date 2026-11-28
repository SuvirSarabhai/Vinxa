import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { migrate } from './migrations'
import { meetingSchema, meetingDetailSchema, librarySchema, meetingIdSchema, meetingCommandSchema } from '../../shared/meetings'
import type { Meeting, MeetingRepository, NoteSources, TranscriptRepository } from '../../shared/meetings'
import { meetingInsightsSchema, recordingConfigSchema, transcriptSegmentSchema } from '../../shared/schemas'
import type { MeetingInsights, RecordingConfig, TranscriptSegment } from '../../shared/contracts'
import { bookmarks } from '../phase5/data'

const selectMeeting = `SELECT m.*,
  (SELECT COUNT(*) FROM action_items a WHERE a.meetingId=m.id) AS actionItemCount,
  (SELECT COUNT(*) FROM action_items a WHERE a.meetingId=m.id AND a.status='pending') AS pendingActionCount
  FROM meetings m`
const storedSegment = z.object({ ...transcriptSegmentSchema.shape,
  isFinal: z.literal(1).transform(() => true) }).pipe(transcriptSegmentSchema)
export class MeetingStore implements MeetingRepository, TranscriptRepository {
  readonly db: Database.Database
  constructor(readonly userData: string) {
    mkdirSync(userData, { recursive: true })
    this.db = new Database(join(userData, 'meetings.sqlite3'))
    try { migrate(this.db) } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  create(id: string, config: RecordingConfig, startedAt: number): Meeting {
    meetingIdSchema.parse(id)
    const value = recordingConfigSchema.parse(config)
    z.number().int().nonnegative().parse(startedAt)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO meetings(id,title,startedAt,recordingStatus,createdAt,updatedAt)
        VALUES (?,?,?,'recording',?,?)`).run(id, value.title, startedAt, now, now)
      const insert = this.db.prepare('INSERT INTO speakers VALUES (?,?,?)')
      insert.run(id, 'mic', 'You')
      insert.run(id, 'system', 'Remote')
    })()
    return this.meeting(id)
  }
  meeting(id: string): Meeting {
    const row = this.db.prepare(selectMeeting + ' WHERE m.id = ?').get(meetingIdSchema.parse(id))
    if (!row) throw new Error('Meeting was not found.')
    return meetingSchema.parse(row)
  }
  list() {
    const meetings = this.db.prepare(selectMeeting + ' ORDER BY m.startedAt DESC,m.id').all()
    const stats = this.db.prepare(`SELECT (SELECT COUNT(*) FROM meetings) AS totalMeetings,
      (SELECT COUNT(*) FROM action_items WHERE status='pending') AS pendingActions`).get()
    return librarySchema.parse({ meetings, stats })
  }
  transcript(id: string): TranscriptSegment[] {
    return this.db.prepare(`SELECT t.id,t.meetingId,t.source,COALESCE(r.label,t.speakerId) speakerId,t.text,t.startMs,t.endMs,t.isFinal
      FROM transcript_segments t LEFT JOIN remote_speakers r ON r.meetingId=t.meetingId AND r.segmentId=t.id
      WHERE t.meetingId=? ORDER BY t.startMs,t.endMs,t.id`)
      .all(meetingIdSchema.parse(id)).map(row => storedSegment.parse(row))
  }
  get(id: string) {
    const meeting = this.meeting(id)
    const notes = z.object({ summary: z.string() }).optional().parse(this.db.prepare('SELECT summary FROM meeting_notes WHERE meetingId=?').get(id))
    const decisions = this.db.prepare('SELECT text,atMs FROM decisions WHERE meetingId=? ORDER BY atMs,id').all(id)
    const actions = this.db.prepare('SELECT id,task,owner,due,status FROM action_items WHERE meetingId=? ORDER BY rowid').all(id)
    const speakers = z.array(z.object({ source: z.enum(['mic', 'system']), displayName: z.string() }))
      .parse(this.db.prepare('SELECT source,displayName FROM speakers WHERE meetingId=?').all(id))
    const names = { mic: 'You', system: 'Remote' }
    for (const speaker of speakers) names[speaker.source] = speaker.displayName
    return meetingDetailSchema.parse({ meeting, transcript: this.transcript(id), actions, speakers: names, bookmarks: bookmarks(this, id),
      insights: notes ? { summary: notes.summary, decisions,
        actionItems: actions.map(row => { const { id: _id, ...action } = z.object({
          id: z.string(), task: z.string(), owner: z.string().nullable(), due: z.string().nullable(), status: z.enum(['pending', 'done'])
        }).parse(row); return action }) } : null })
  }
  saveFinal(input: TranscriptSegment): void {
    const value = transcriptSegmentSchema.parse(input)
    if (!value.isFinal || !value.text.trim()) return
    meetingIdSchema.parse(value.meetingId)
    const segment = { id: value.id, meetingId: value.meetingId, source: value.source,
      speakerId: value.source === 'mic' ? 'you' : 'remote', text: value.text, startMs: value.startMs, endMs: value.endMs, isFinal: 1 as const }
    this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM transcript_segments WHERE meetingId=? AND id=?').get(value.meetingId, value.id)
      if (previous) {
        const old = storedSegment.parse(previous)
        if (old.text !== value.text || old.source !== value.source || old.startMs !== value.startMs || old.endMs !== value.endMs) {
          throw new Error('Conflicting finalized transcript segment.')
        }
        return
      }
      const meeting = this.meeting(value.meetingId)
      if (!['recording', 'paused', 'stopping'].includes(meeting.recordingStatus)) throw new Error('The saved transcript is finalized.')
      this.db.prepare(`INSERT INTO transcript_segments(id,meetingId,source,speakerId,text,startMs,endMs,isFinal)
        VALUES (@id,@meetingId,@source,@speakerId,@text,@startMs,@endMs,@isFinal)`).run(segment)
      this.db.prepare('UPDATE meetings SET updatedAt=? WHERE id=?').run(Date.now(), value.meetingId)
    })()
  }
  rename(id: string, title: string): void {
    const value = meetingCommandSchema.parse({ type: 'rename', id, title })
    if (value.type !== 'rename') return
    this.meeting(id)
    this.db.prepare('UPDATE meetings SET title=?,updatedAt=? WHERE id=?').run(value.title, Date.now(), id)
  }
  recording(id: string, status: Meeting['recordingStatus'], endedAt?: number, error?: string): void {
    const meeting = this.meeting(id)
    meetingSchema.shape.recordingStatus.parse(status)
    if (endedAt !== undefined) z.number().int().min(meeting.startedAt).parse(endedAt)
    this.db.prepare(`UPDATE meetings SET recordingStatus=?,endedAt=?,duration=?,error=?,updatedAt=? WHERE id=?`)
      .run(status, endedAt ?? meeting.endedAt, endedAt === undefined ? meeting.duration : endedAt - meeting.startedAt,
        error ?? meeting.error, Date.now(), id)
  }
  audio(id: string, paths: { microphoneAudioPath: string | null; systemAudioPath: string | null }): void {
    this.meeting(id)
    this.db.prepare('UPDATE meetings SET microphoneAudioPath=?,systemAudioPath=?,updatedAt=? WHERE id=?')
      .run(paths.microphoneAudioPath, paths.systemAudioPath, Date.now(), id)
  }
  notesStatus(id: string, status: Meeting['notesStatus'], message?: string): void {
    this.meeting(id)
    meetingSchema.shape.notesStatus.parse(status)
    this.db.prepare('UPDATE meetings SET notesStatus=?,notesMessage=?,updatedAt=? WHERE id=?')
      .run(status, message ?? null, Date.now(), id)
  }
  replaceInsights(id: string, input: MeetingInsights, provider: string, model: string, sources?: NoteSources): void {
    const insights = meetingInsightsSchema.parse(input)
    if (!['completed', 'processing'].includes(this.meeting(id).recordingStatus)) throw new Error('Finish recording before generating notes.')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM note_sources WHERE meetingId=?').run(id)
      const link = this.db.prepare('INSERT INTO note_sources VALUES (?,?,?)')
      if (sources?.summary) link.run(id, id, sources.summary)
      const previousActions = this.get(id).actions
      this.db.prepare('DELETE FROM decisions WHERE meetingId=?').run(id)
      this.db.prepare('DELETE FROM action_items WHERE meetingId=?').run(id)
      this.db.prepare(`INSERT INTO meeting_notes VALUES (?,?,?,?,?) ON CONFLICT(meetingId)
        DO UPDATE SET summary=excluded.summary,provider=excluded.provider,model=excluded.model,generatedAt=excluded.generatedAt`)
        .run(id, insights.summary, provider, model, Date.now())
      const decision = this.db.prepare('INSERT INTO decisions VALUES (?,?,?,?)')
      for (const [index, item] of insights.decisions.entries()) {
        const targetId = randomUUID()
        decision.run(targetId, id, item.text, item.atMs)
        if (sources) link.run(id, targetId, sources.decisions[index])
      }
      const action = this.db.prepare('INSERT INTO action_items VALUES (?,?,?,?,?,?)')
      for (const [index, item] of insights.actionItems.entries()) {
        const previous = previousActions.find(old => old.task === item.task && old.owner === item.owner && old.due === item.due)
        const targetId = previous?.id ?? randomUUID()
        if (sources) link.run(id, targetId, sources.actions[index])
        action.run(targetId, id, item.task, item.owner, item.due, previous?.status ?? item.status)
      }
      this.notesStatus(id, 'completed', 'Notes saved.')
      this.db.prepare("UPDATE crm_deliveries SET status='stale' WHERE meetingId=? AND status='sent'").run(id)
    })()
  }
  renameSpeaker(id: string, source: 'mic' | 'system', name: string): void {
    const value = meetingCommandSchema.parse({ type: 'speaker', id, source, name })
    if (value.type !== 'speaker') return
    this.meeting(id)
    this.db.prepare('UPDATE speakers SET displayName=? WHERE meetingId=? AND source=?').run(value.name, id, source)
  }
  actionStatus(id: string, actionId: string, status: 'pending' | 'done'): void {
    meetingCommandSchema.parse({ type: 'action', id, actionId, status })
    if (!this.db.prepare('UPDATE action_items SET status=? WHERE id=? AND meetingId=?').run(status, actionId, id).changes) {
      throw new Error('Action item was not found.')
    }
    this.db.prepare("UPDATE crm_deliveries SET status='stale' WHERE meetingId=? AND status='sent'").run(id)
  }
  setting(key: string): string | undefined {
    return z.object({ value: z.string() }).optional().parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key))?.value
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }
}
