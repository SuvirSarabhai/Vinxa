import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FixturePlayer } from './fixture-player'

describe('FixturePlayer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('replaces a partial using the same id and emits both audio sources', () => {
    const emit = vi.fn()
    const status = vi.fn()
    const player = new FixturePlayer(emit, status)
    player.play()
    vi.advanceTimersByTime(300)
    const partial = emit.mock.calls[0][0]
    expect(partial.isFinal).toBe(false)
    vi.advanceTimersByTime(1200)
    expect(emit.mock.calls[1][0]).toMatchObject({ id: partial.id, isFinal: true })
    vi.runAllTimers()
    expect(emit.mock.calls.some(([segment]) => segment.source === 'system')).toBe(true)
    expect(status).toHaveBeenLastCalledWith('completed')
  })

  it('pauses time without emitting and resumes with the remaining delay', () => {
    const emit = vi.fn()
    const player = new FixturePlayer(emit, vi.fn())
    player.play()
    vi.advanceTimersByTime(100)
    player.pause()
    vi.advanceTimersByTime(5000)
    expect(emit).not.toHaveBeenCalled()
    player.play()
    vi.advanceTimersByTime(199)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(1)
    player.stop()
    vi.runAllTimers()
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('does not start duplicate timelines and restarts from the beginning after reset', () => {
    const emit = vi.fn()
    const player = new FixturePlayer(emit, vi.fn())
    player.play()
    player.play()
    vi.advanceTimersByTime(300)
    expect(emit).toHaveBeenCalledTimes(1)
    player.stop()
    player.play()
    vi.advanceTimersByTime(300)
    expect(emit.mock.calls[1][0].id).toBe(emit.mock.calls[0][0].id)
    player.stop()
  })
})
