import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MeetingStore } from '../db/repository'
import { bookmarkSchema, passageSchema } from '../../shared/phase5'

export function bookmarks(store: MeetingStore, id: string) {
  store.meeting(id)
  return z.array(bookmarkSchema).parse(store.db.prepare('SELECT * FROM bookmarks WHERE meetingId=? ORDER BY atMs,id').all(id))
}
export function addBookmark(store: MeetingStore, id: string, atMs: number) {
  const meeting = store.meeting(id)
  if (meeting.recordingStatus !== 'recording') throw new Error('Bookmarks require an active, unpaused recording.')
  const value = bookmarkSchema.parse({ id: randomUUID(), meetingId: id, atMs, note: 'Bookmarked moment' })
  store.db.prepare('INSERT INTO bookmarks VALUES (@id,@meetingId,@atMs,@note)').run(value)
  return value
}
/** Extractive answers: every displayed word of evidence comes from saved text. */
export function askMeetings(store: MeetingStore, question: string) {
  const stop = new Set('a an the is are was were do does did i we you they it to of in on for and or what when who how where why please tell me about'.split(' '))
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])].filter(w => !stop.has(w)).slice(0, 16)
  if (!words.length) return []
  const query = words.map(w => '"' + w + '"*').join(' OR ')
  return z.array(passageSchema).parse(store.db.prepare(`
    SELECT t.meetingId,m.title,t.id segmentId,COALESCE(r.label,s.displayName,t.source) speaker,t.startMs atMs,t.text
    FROM transcript_fts JOIN transcript_segments t ON t.rowid=transcript_fts.rowid
    JOIN meetings m ON m.id=t.meetingId
    LEFT JOIN speakers s ON s.meetingId=t.meetingId AND s.source=t.source
    LEFT JOIN remote_speakers r ON r.meetingId=t.meetingId AND r.segmentId=t.id
    WHERE transcript_fts MATCH ? AND m.recordingStatus IN ('completed','interrupted','error')
      AND m.id NOT IN (SELECT meetingId FROM deletion_jobs)
    ORDER BY bm25(transcript_fts),m.startedAt DESC,t.startMs LIMIT 8
  `).all(query))
}
