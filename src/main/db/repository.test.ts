import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MeetingStore } from './repository'
import { migrate } from './migrations'
import { migrations } from './migrations'
import Database from 'better-sqlite3'
const folders: string[] = []
const stores: MeetingStore[] = []
function open(folder = mkdtempSync(join(tmpdir(), 'vinxa-db-'))) {
  if (!folders.includes(folder)) folders.push(folder)
  const store = new MeetingStore(folder)
  stores.push(store)
  return store
}
const config = { title: 'Review', microphoneEnabled: true, systemAudioEnabled: true, microphoneDeviceId: null }
afterEach(() => { for (const s of stores.splice(0)) if (s.db.open) s.close(); for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true }) })
describe('SQLite meeting repository (real SQLite)', () => {
  it('upgrades existing version-one records and rolls back a failed migration', () => {
    const folder = mkdtempSync(join(tmpdir(), 'vinxa-migration-')); folders.push(folder)
    const db = new Database(join(folder,'meetings.sqlite3'))
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,appliedAt INTEGER NOT NULL)')
    db.exec(migrations[0].sql)
    db.prepare('INSERT INTO schema_migrations VALUES(1,0)').run()
    const id = randomUUID()
    db.prepare("INSERT INTO meetings(id,title,startedAt,recordingStatus,createdAt,updatedAt) VALUES(?, 'Existing',0,'recording',0,0)").run(id)
    db.prepare("INSERT INTO transcript_segments VALUES('old',?,'mic','you','Café upgrade',0,100,1)").run(id)
    db.close()
    const upgraded=open(folder)
    expect(upgraded.transcript(id)[0].text).toBe('Café upgrade')
    expect(upgraded.db.prepare("SELECT * FROM transcript_fts WHERE transcript_fts MATCH 'cafe'").all()).toHaveLength(1)
    const broken = new Database(':memory:')
    try {
      broken.exec('CREATE TABLE action_items(userValue TEXT); INSERT INTO action_items VALUES(\'keep\')')
      expect(()=>migrate(broken)).toThrow()
      expect(broken.prepare("SELECT name FROM sqlite_master WHERE name='meetings'").get()).toBeUndefined()
      expect(broken.prepare('SELECT * FROM action_items').get()).toEqual({userValue:'keep'})
      expect(broken.prepare('SELECT * FROM schema_migrations').all()).toEqual([])
    } finally { broken.close() }
  })
  it('keeps FTS prefix and accent matching consistent across insert, update and delete', () => {
    const store = open(), id = randomUUID()
    store.create(id, config, 100)
    store.saveFinal({ id: 'fts', meetingId: id, source: 'mic', speakerId: null, text: 'Café planning',
      startMs: 0, endMs: 100, isFinal: true })
    const search = (term: string) => store.db.prepare('SELECT meetingId,source,startMs FROM transcript_fts WHERE transcript_fts MATCH ?').all(term)
    expect(search('cafe')).toHaveLength(1)
    expect(search('plan*')).toEqual([{ meetingId: id, source: 'mic', startMs: 0 }])
    store.db.prepare('UPDATE transcript_segments SET text=? WHERE meetingId=?').run('Renamed', id)
    expect(search('cafe')).toHaveLength(0)
    expect(search('ren*')).toHaveLength(1)
    store.db.prepare('DELETE FROM transcript_segments WHERE meetingId=?').run(id)
    expect(search('ren*')).toHaveLength(0)
    store.db.prepare("INSERT INTO transcript_fts(transcript_fts,rank) VALUES('integrity-check',1)").run()
  })
  it('migrates transactionally and retains meetings after reopening', () => {
    const store = open()
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(store.db.pragma('secure_delete', { simple: true })).toBe(1)
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1)
    const id = randomUUID()
    store.create(id, config, 100)
    migrate(store.db)
    store.rename(id, 'Saved title')
    store.close()
    expect(open(store.userData).get(id).meeting.title).toBe('Saved title')
  })
  it('persists only final segments, orders them, and rejects conflicting repeated delivery', () => {
    const store = open(), id = randomUUID()
    store.create(id, config, 100)
    const segment = { id: 'later', meetingId: id, source: 'mic' as const, speakerId: null, text: 'Later', startMs: 500, endMs: 700, isFinal: true }
    store.saveFinal({ ...segment, isFinal: false })
    expect(store.transcript(id)).toEqual([])
    store.saveFinal(segment); store.saveFinal(segment)
    store.saveFinal({ ...segment, id: 'earlier', source: 'system', startMs: 0, endMs: 100 })
    expect(store.transcript(id).map(s => s.speakerId)).toEqual(['remote', 'you'])
    expect(() => store.saveFinal({ ...segment, text: 'Changed' })).toThrow('Conflicting')
    store.recording(id, 'completed', 1000)
    expect(() => store.saveFinal({ ...segment, id: 'late' })).toThrow('finalized')
    store.saveFinal(segment)
  })
  it('replaces valid notes atomically, persists actions and speaker names, and retains prior notes on invalid regeneration', () => {
    const store = open(), id = randomUUID()
    store.create(id, config, 100); store.recording(id, 'completed', 1000)
    const insights = { summary: 'Reviewed', decisions: [{ text: 'Ship', atMs: 30 }],
      actionItems: [{ task: 'Review', owner: null, due: null, status: 'pending' as const }] }
    store.replaceInsights(id, insights, 'ollama', 'local')
    const action = store.get(id).actions[0]
    store.actionStatus(id, action.id, 'done')
    store.replaceInsights(id, insights, 'ollama', 'local')
    expect(store.get(id).actions[0]).toMatchObject({ id: action.id, status: 'done' })
    store.renameSpeaker(id, 'system', 'Client')
    expect(store.list().stats.pendingActions).toBe(0)
    expect(() => store.replaceInsights(id, { ...insights, decisions: [{ text: '', atMs: 3 }] }, 'ollama', 'local')).toThrow()
    store.notesStatus(id, 'failed', 'Provider failed')
    store.close()
    const saved = open(store.userData).get(id)
    expect(saved.insights?.summary).toBe('Reviewed')
    expect(saved.actions[0].status).toBe('done')
    expect(saved.speakers.system).toBe('Client')
    expect(saved.meeting.notesStatus).toBe('failed')
  })
})
