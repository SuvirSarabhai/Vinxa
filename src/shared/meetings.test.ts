import { describe, expect, it } from 'vitest'
import { MeetingInsightsSchema, meetingCommandSchema, notesSettingsSchema } from './meetings'
describe('meeting contracts', () => {
  it('defaults to local notes with cloud explicitly disabled', () => {
    expect(notesSettingsSchema.parse({})).toMatchObject({ provider: 'ollama', cloudEnabled: false })
  })
  it('requires explicit nullable owners and supported action states', () => {
    expect(MeetingInsightsSchema.safeParse({ summary: '', decisions: [], actionItems: [{ task: 'Review', status: 'pending' }] }).success).toBe(false)
    expect(MeetingInsightsSchema.safeParse({ summary: '', decisions: [{ text: 'Agreed', atMs: -1 }], actionItems: [] }).success).toBe(false)
  })
  it('rejects paths and unknown IPC fields', () => {
    expect(meetingCommandSchema.safeParse({ type: 'notes', id: '../meeting' }).success).toBe(false)
  })
})
