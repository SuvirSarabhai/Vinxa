import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MeetingStore } from '../db/repository'
import { addBookmark, askMeetings, bookmarks } from './data'
import { mockCrmEndpoint, sendMockCrm } from './crm'
import { callCandidates } from './detection'
import { speakerAssignments } from './clustering'
import { saveSpeechTuning, speechTuning } from './speech'
import { meetingMarkdown } from '../export/markdown'
import { searchMeetings } from '../db/search'
import { deleteMeeting } from '../delete-meeting'

vi.mock('electron', () => ({ app: { getAppPath: () => '' } }))
const stores: MeetingStore[] = [], folders: string[] = []
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'vinxa-phase5-')); folders.push(folder)
  const store = new MeetingStore(folder); stores.push(store)
  const id = randomUUID()
  store.create(id, { title: 'Project review', microphoneEnabled: true, systemAudioEnabled: true, microphoneDeviceId: null }, 1000)
  const segment = { id: 'original', meetingId: id, source: 'system' as const, speakerId: 'remote', text: 'We agreed to ship the café dashboard on Friday.', startMs: 100, endMs: 1100, isFinal: true }
  store.saveFinal(segment)
  return { store, id, segment, folder }
}
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('Phase 5 persistence and privacy boundaries', () => {
  it('persists bookmarks across restart, exports them, and rejects marks while paused', () => {
    const { store, id, folder } = fixture()
    addBookmark(store, id, 250)
    store.recording(id, 'paused')
    expect(() => addBookmark(store, id, 500)).toThrow('unpaused')
    store.close()
    const reopened = new MeetingStore(folder); stores.push(reopened)
    expect(bookmarks(reopened, id)).toMatchObject([{ atMs: 250, meetingId: id }])
    expect(meetingMarkdown(reopened.get(id))).toContain('## Bookmarks')
  })
  it('answers only with original finalized passages and returns no evidence for unknown terms', () => {
    const { store, id } = fixture()
    expect(askMeetings(store, 'When is café shipping?')).toEqual([])
    store.recording(id, 'completed', 2500)
    const answer = askMeetings(store, 'When is café shipping?')
    expect(answer).toMatchObject([{ meetingId: id, segmentId: 'original', text: 'We agreed to ship the café dashboard on Friday.', speaker: 'Remote', atMs: 100 }])
    expect(askMeetings(store, 'unrelatedplatypus')).toEqual([])
    store.db.prepare("INSERT INTO deletion_jobs VALUES (?,'files',NULL)").run(id)
    expect(askMeetings(store, 'café')).toEqual([])
  })
  it('keeps clustering derived, excludes microphone/mixed turns, and carries labels into search/export', () => {
    const { store, id, segment } = fixture()
    const turns = [{ startMs: 100, endMs: 1100, speaker: 7 }]
    expect(speakerAssignments([{ ...segment, source: 'mic' }], turns)).toEqual([])
    expect(speakerAssignments([segment], [{ startMs: 100, endMs: 600, speaker: 1 }, { startMs: 600, endMs: 1100, speaker: 2 }])).toEqual([])
    const assigned = speakerAssignments([segment], turns)
    expect(assigned).toEqual([{ segmentId: segment.id, label: 'Remote 1' }])
    store.db.prepare('INSERT INTO remote_speakers VALUES (?,?,?)').run(id, segment.id, assigned[0].label)
    expect(store.transcript(id)[0].speakerId).toBe('Remote 1')
    expect(store.db.prepare('SELECT speakerId FROM transcript_segments WHERE meetingId=?').get(id)).toEqual({ speakerId: 'remote' })
    expect(searchMeetings(store, 'cafe')[0].speaker).toBe('Remote 1')
    expect(meetingMarkdown(store.get(id))).toContain('Remote 1')
  })
  it.each(['https://crm.example/vinxa/decisions','http://localhost:4319/vinxa/decisions','http://127.0.0.1:4319/other','http://127.0.0.1:4319/vinxa/decisions?forward=remote','http://user@127.0.0.1:4319/vinxa/decisions'])('rejects non-mock CRM destination %s', endpoint => {
    expect(() => mockCrmEndpoint(endpoint)).toThrow('local mock endpoint')
  })
  it('records sent status only after matching acknowledgement and keeps retries idempotent', async () => {
    const { store, id } = fixture()
    store.recording(id, 'completed', 2500)
    store.replaceInsights(id, { summary: 'Release planned.', decisions: [{ text: 'Ship Friday', atMs: 100 }], actionItems: [] }, 'mock', 'mock')
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const key = (init!.headers as Record<string,string>)['Idempotency-Key']
      const body = JSON.parse(String(init!.body))
      expect(body).not.toHaveProperty('transcript'); expect(body).not.toHaveProperty('audio')
      expect(init!.redirect).toBe('error')
      return Response.json({ accepted: true, idempotencyKey: key })
    })
    const endpoint = 'http://127.0.0.1:4319/vinxa/decisions'
    await sendMockCrm(store, id, endpoint, 'client', fetcher)
    await sendMockCrm(store, id, endpoint, 'client', fetcher)
    expect(fetcher.mock.calls[0][1]!.body).toBe(fetcher.mock.calls[1][1]!.body)
    expect(store.db.prepare('SELECT status FROM crm_deliveries').get()).toEqual({ status: 'sent' })
    store.replaceInsights(id, { summary: 'Updated release.', decisions: [{ text: 'Ship Monday', atMs: 100 }], actionItems: [] }, 'mock', 'mock')
    expect(store.db.prepare('SELECT status FROM crm_deliveries').get()).toEqual({ status: 'stale' })
    fetcher.mockResolvedValueOnce(Response.json({ accepted: true, idempotencyKey: 'wrong' }))
    await expect(sendMockCrm(store, id, endpoint, 'client', fetcher)).rejects.toThrow('not acknowledged')
    expect(store.db.prepare('SELECT status,sentAt FROM crm_deliveries').get()).toEqual({ status: 'failed', sentAt: null })
  })
  it('deletes bookmark, clustering and CRM metadata alongside the saved meeting', async () => {
    const { store, id, segment } = fixture()
    addBookmark(store, id, 400)
    store.db.prepare('INSERT INTO remote_speakers VALUES (?,?,?)').run(id, segment.id, 'Remote 1')
    store.db.prepare("INSERT INTO crm_deliveries VALUES (?,'client','local','sent',1)").run(id)
    store.recording(id, 'completed', 2500)
    await deleteMeeting(store, id)
    for (const table of ['bookmarks','remote_speakers','crm_deliveries']) expect(store.db.prepare('SELECT * FROM '+table).all()).toEqual([])
    expect(askMeetings(store, 'cafe')).toEqual([])
  })
  it('detects only call-like app windows, not browser pages or idle client windows', () => {
    expect(callCandidates([{ process: 'Zoom', title: 'Zoom Meeting' }, { process: 'ms-teams', title: 'Call with Alex' },
      { process: 'chrome', title: 'Meeting - Meet' }, { process: 'Teams', title: 'Chat | Teams' }])).toEqual(['zoom','ms-teams'])
  })
  it('validates speech settings and rejects English-only models for Hindi', () => {
    const { folder } = fixture()
    expect(() => saveSpeechTuning(folder, { model: 'base.en', language: 'hi', vadThreshold: 0.5, vadRelease: 0.35 })).toThrow('multilingual')
    expect(() => saveSpeechTuning(folder, { model: 'small', language: 'hi', vadThreshold: 0.2, vadRelease: 0.7 })).toThrow()
    saveSpeechTuning(folder, { model: 'small', language: 'hi', vadThreshold: 0.55, vadRelease: 0.3 })
    expect(speechTuning(folder)).toMatchObject({ model: 'small', language: 'hi', vadThreshold: 0.55 })
  })
})
