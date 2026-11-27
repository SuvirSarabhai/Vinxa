import { describe, expect, it } from 'vitest'
import { defaultHotkeys, hotkeysSchema, phase2CommandSchema } from './phase2'

describe('Phase 2 boundary validation', () => {
  it('requires explicit consent and rejects undeclared command fields', () => {
    const command = { type: 'confirm', config: { title: 'Demo', microphoneEnabled: true, systemAudioEnabled: false, microphoneDeviceId: null }, consent: true }
    expect(phase2CommandSchema.safeParse(command).success).toBe(true)
    expect(phase2CommandSchema.safeParse({ ...command, consent: false }).success).toBe(false)
    expect(phase2CommandSchema.safeParse({ ...command, bypassConsent: true }).success).toBe(false)
  })

  it('normalizes shortcuts and rejects duplicates and invalid opacity', () => {
    expect(hotkeysSchema.parse({ ...defaultHotkeys, start: 'ctrl+alt+r' }).start).toBe('Ctrl+Alt+R')
    expect(hotkeysSchema.safeParse({ ...defaultHotkeys, pause: 'ctrl+alt+s' }).success).toBe(false)
    expect(phase2CommandSchema.safeParse({ type: 'opacity', value: 0.2 }).success).toBe(false)
    expect(phase2CommandSchema.safeParse({ type: 'opacity', value: Infinity }).success).toBe(false)
  })
})
