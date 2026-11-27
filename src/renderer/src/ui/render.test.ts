import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AudioCard, ModeBadge, SessionControls } from './SessionWidgets'
import { Setup } from './Setup'
import { Transcript } from './Transcript'
import { timestamp } from './session'
import type { Phase2Snapshot } from '../../../shared/phase2'

function snapshot(overrides: Partial<Phase2Snapshot> = {}): Phase2Snapshot {
  return {
    state: 'idle',
    mode: 'local',
    busy: false,
    consentRequest: 1,
    config: {
      title: 'Meeting',
      microphoneEnabled: true,
      systemAudioEnabled: false,
      microphoneDeviceId: null
    },
    segments: [],
    sessionId: null,
    error: null,
    notice: '',
    pauses: [],
    levels: { mic: null, system: null },
    revision: 1,
    ready: true,
    hotkeys: { start: 'Ctrl+Alt+S', pause: 'Ctrl+Alt+P', stop: 'Ctrl+Alt+X' },
    activeHotkeys: [],
    hotkeyErrors: [],
    collapsed: false,
    opacity: 0.95,
    engine: { ready: true, message: 'Local speech is ready.' },
    ...overrides
  }
}

describe('integrated Stitch UI', () => {
  it('uses the real backend mode instead of the export’s unconditional Demo label', () => {
    expect(renderToStaticMarkup(createElement(ModeBadge, { snapshot: snapshot() }))).not.toContain('Demo')
    expect(
      renderToStaticMarkup(createElement(ModeBadge, { snapshot: snapshot({ mode: 'demo' }) }))
    ).toContain('Demo')
  })

  it('does not offer an enabled Start control before the speech engine is ready', () => {
    const html = renderToStaticMarkup(
      createElement(SessionControls, {
        snapshot: snapshot({ engine: { ready: false, message: 'Warming up' } }),
        command: vi.fn(),
        busy: false
      })
    )
    expect(html).toMatch(/disabled=""[^>]*>[\s\S]*?Start session/)
  })

  it('shows inactive source meters before consent rather than simulated device activity', () => {
    const html = renderToStaticMarkup(createElement(AudioCard, { source: 'mic', snapshot: snapshot() }))
    expect(html).toContain('Inactive')
    expect(html).toContain('value="0"')
    expect(html).not.toContain('Realtek')
  })

  it('requires consent before enabling Confirm and explains independent microphone capture', () => {
    const html = renderToStaticMarkup(
      createElement(Setup, { snapshot: snapshot(), command: vi.fn(), busy: false, error: '' })
    )
    expect(html).toMatch(/type="submit" disabled=""/)
    expect(html).toContain('Meeting-app mute does not mute Vinxa.')
    expect(html).toContain('Nearby voices can be captured.')
  })

  it('places pause gaps between the matching transcript entries and distinguishes provisional words', () => {
    const base = { meetingId: 'meeting', source: 'mic' as const, speakerId: 'you', isFinal: true }
    const html = renderToStaticMarkup(
      createElement(Transcript, {
        snapshot: snapshot({
          segments: [
            { ...base, id: 'first', text: 'Before the pause', startMs: 0, endMs: 1000 },
            { ...base, id: 'second', text: 'After the pause', startMs: 5000, endMs: 6000, isFinal: false }
          ],
          pauses: [{ startMs: 2000, endMs: 4000 }]
        })
      })
    )
    expect(html.indexOf('Before the pause')).toBeLessThan(html.indexOf('Paused ·'))
    expect(html.indexOf('Paused ·')).toBeLessThan(html.indexOf('After the pause'))
    expect(html).toContain('segment partial')
  })

  it('preserves hours in long meetings instead of wrapping timestamps after 59 minutes', () => {
    expect(timestamp(3661000)).toBe('01:01:01')
  })
})
