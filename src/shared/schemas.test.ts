import { describe, expect, it } from 'vitest'
import { fixtureCommandSchema, meetingInsightsSchema, recordingConfigSchema, sidecarEventSchema, transcriptSegmentSchema } from './schemas'

describe('boundary validation', () => {
  it('rejects impossible transcript timestamps and unsupported sources', () => {
    const segment = { id: 'one', meetingId: 'meeting', speakerId: null, text: 'hello', source: 'mic', startMs: 100, endMs: 200, isFinal: true }
    expect(transcriptSegmentSchema.safeParse(segment).success).toBe(true)
    expect(transcriptSegmentSchema.safeParse({ ...segment, endMs: 50 }).success).toBe(false)
    expect(transcriptSegmentSchema.safeParse({ ...segment, source: 'unknown' }).success).toBe(false)
    expect(sidecarEventSchema.safeParse({ type: 'final', source: 'mic', text: 'hello', startMs: 200, endMs: 100 }).success).toBe(false)
  })

  it('requires an audio source and rejects arbitrary fixture commands', () => {
    expect(recordingConfigSchema.safeParse({ title: 'Demo', microphoneEnabled: false, systemAudioEnabled: false, microphoneDeviceId: null }).success).toBe(false)
    expect(fixtureCommandSchema.safeParse('record').success).toBe(false)
  })

  it('requires explicit nulls for unknown action owners and dates', () => {
    const insights = { summary: 'Demo', decisions: [], actionItems: [{ task: 'Review', owner: null, due: null, status: 'pending' }] }
    expect(meetingInsightsSchema.safeParse(insights).success).toBe(true)
    expect(meetingInsightsSchema.safeParse({ ...insights, actionItems: [{ task: 'Review', status: 'pending' }] }).success).toBe(false)
  })
})
