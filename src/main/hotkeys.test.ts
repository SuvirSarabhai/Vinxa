import { describe, expect, it, vi } from 'vitest'
import { ShortcutBindings } from './hotkeys'
import { defaultHotkeys } from '../shared/phase2'

function harness() {
  const callbacks = new Map<string, () => void>()
  const unavailable = new Set<string>()
  const registrar = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (unavailable.has(accelerator) || callbacks.has(accelerator)) return false
      callbacks.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => { callbacks.delete(accelerator) })
  }
  const dispatch = vi.fn()
  const bindings = new ShortcutBindings(registrar, dispatch)
  return { bindings, callbacks, unavailable, registrar, dispatch }
}

describe('ShortcutBindings', () => {
  it('preserves existing shortcuts if any candidate conflicts', () => {
    const target = harness()
    target.bindings.apply(defaultHotkeys)
    target.unavailable.add('Ctrl+Alt+T')
    expect(() => target.bindings.apply({ start: 'Ctrl+Alt+R', pause: 'Ctrl+Alt+P', stop: 'Ctrl+Alt+T' })).toThrow('unavailable')
    expect([...target.callbacks.keys()].sort()).toEqual(Object.values(defaultHotkeys).sort())
    target.callbacks.get('Ctrl+Alt+S')!()
    expect(target.dispatch).toHaveBeenLastCalledWith('start')
  })

  it('supports swapping already registered shortcuts without losing their callbacks', () => {
    const target = harness()
    target.bindings.apply(defaultHotkeys)
    target.bindings.apply({ ...defaultHotkeys, start: defaultHotkeys.pause, pause: defaultHotkeys.start })
    target.callbacks.get(defaultHotkeys.start)!()
    expect(target.dispatch).toHaveBeenLastCalledWith('pause')
    expect(target.registrar.register).toHaveBeenCalledTimes(3)
  })

  it('unregisters only shortcuts owned by this registry', () => {
    const target = harness()
    target.callbacks.set('Ctrl+Alt+U', () => undefined)
    target.bindings.apply(defaultHotkeys)
    target.bindings.dispose()
    expect([...target.callbacks.keys()]).toEqual(['Ctrl+Alt+U'])
  })
})
