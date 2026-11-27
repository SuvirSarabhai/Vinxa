import { hotkeysSchema } from '../shared/phase2'
import type { HotkeyAction, Hotkeys } from '../shared/phase2'

export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export class ShortcutBindings {
  private current: Hotkeys | undefined
  private owned = new Set<string>()

  constructor(private readonly registrar: ShortcutRegistrar, private readonly dispatch: (action: HotkeyAction) => void) {}

  apply(value: Hotkeys): void {
    const next = hotkeysSchema.parse(value)
    const added: string[] = []
    try {
      for (const accelerator of Object.values(next)) {
        if (this.owned.has(accelerator)) continue
        if (!this.registrar.register(accelerator, () => {
          const action = (Object.keys(this.current ?? {}) as HotkeyAction[])
            .find((candidate) => this.current?.[candidate] === accelerator)
          if (action) this.dispatch(action)
        })) throw new Error(`${accelerator} is unavailable. Choose another shortcut or use the tray menu.`)
        added.push(accelerator)
      }
    } catch (error) {
      added.forEach((accelerator) => this.registrar.unregister(accelerator))
      throw error
    }
    for (const accelerator of this.owned) {
      if (!Object.values(next).includes(accelerator)) this.registrar.unregister(accelerator)
    }
    this.owned = new Set(Object.values(next))
    this.current = next
  }

  active(): string[] {
    return [...this.owned]
  }

  bindings(): Hotkeys | undefined {
    return this.current ? { ...this.current } : undefined
  }

  dispose(): void {
    this.owned.forEach((accelerator) => this.registrar.unregister(accelerator))
    this.owned.clear()
    this.current = undefined
  }
}
