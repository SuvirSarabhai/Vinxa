import type { MeetingStore } from './repository'
import { searchQuerySchema, searchResultsSchema } from '../../shared/phase4'
// Accept words rather than passing FTS operators from the UI. A trailing prefix
// is supported for every term. Quotes/operators/punctuation are harmless input.
export function searchMeetings(store: MeetingStore, input: string) {
  const words = searchQuerySchema.parse(input).match(/[\p{L}\p{N}\p{M}]+/gu)?.slice(0,20) ?? []
  if (!words.length) return []
  const query = words.map(word => '"' + word + '"*').join(' AND ')
  return searchResultsSchema.parse(store.db.prepare(`
    SELECT * FROM (
      SELECT t.meetingId,m.title,'Transcript' category,t.id targetId,t.id segmentId,t.text,
        snippet(transcript_fts,0,char(1),char(2),'…',24) snippet,t.source,
        s.displayName speaker,t.startMs atMs
      FROM transcript_fts JOIN transcript_segments t ON t.rowid=transcript_fts.rowid
      JOIN meetings m ON m.id=t.meetingId LEFT JOIN speakers s ON s.meetingId=m.id AND s.source=t.source
      WHERE transcript_fts MATCH ?
      UNION ALL
      SELECT f.meetingId,m.title,f.category,f.targetId,t.id,f.text,
        snippet(notes_fts,0,char(1),char(2),'…',24),t.source,s.displayName,COALESCE(f.atMs,t.startMs)
      FROM notes_fts f JOIN meetings m ON m.id=f.meetingId
      LEFT JOIN note_sources n ON n.meetingId=f.meetingId AND n.targetId=f.targetId
      LEFT JOIN transcript_segments t ON t.meetingId=n.meetingId AND t.id=n.segmentId
      LEFT JOIN speakers s ON s.meetingId=t.meetingId AND s.source=t.source WHERE notes_fts MATCH ?
    ) ORDER BY meetingId,COALESCE(atMs,-1),category,targetId LIMIT 200
  `).all(query,query))
}
