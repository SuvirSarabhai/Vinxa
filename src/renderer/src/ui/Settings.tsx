import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { defaultHotkeys, hotkeysSchema } from '../../../shared/phase2'
import type { Hotkeys, Phase2Snapshot } from '../../../shared/phase2'
import { Icon } from './Icon'
import type { CommandHandler } from './session'

export function OpacitySetting({ snapshot, command }: { snapshot: Phase2Snapshot; command: CommandHandler }) {
  const [value, setValue] = useState(Math.round(snapshot.opacity * 100))
  const requested = useRef<number | undefined>(undefined)
  const queued = useRef<number | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const serverValue = useRef(Math.round(snapshot.opacity * 100))
  serverValue.current = Math.round(snapshot.opacity * 100)
  useEffect(() => {
    if (requested.current === undefined || requested.current === serverValue.current) {
      requested.current = undefined
      setValue(serverValue.current)
    }
  }, [snapshot.opacity])
  useEffect(() => () => clearTimeout(timer.current), [])
  async function flush(): Promise<void> {
    clearTimeout(timer.current)
    const next = queued.current
    if (next === undefined) return
    queued.current = undefined
    const success = await command({ type: 'opacity', value: next / 100 })
    if (requested.current === next) {
      if (!success) {
        requested.current = undefined
        setValue(serverValue.current)
      } else if (serverValue.current === next) requested.current = undefined
    }
  }
  return (
    <label className="opacity-setting">
      Opacity
      <input
        aria-label="Overlay opacity"
        type="range"
        min={50}
        max={100}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value)
          setValue(next)
          requested.current = queued.current = next
          clearTimeout(timer.current)
          timer.current = setTimeout(() => void flush(), 120)
        }}
        onBlur={() => void flush()}
        onPointerUp={() => void flush()}
      />
      <output>{value}%</output>
    </label>
  )
}

export function Settings({
  snapshot,
  command,
  busy
}: {
  snapshot: Phase2Snapshot
  command: CommandHandler
  busy: boolean
}) {
  const [bindings, setBindings] = useState<Hotkeys>(snapshot.hotkeys)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setBindings(snapshot.hotkeys)
  }, [snapshot.hotkeys.start, snapshot.hotkeys.pause, snapshot.hotkeys.stop])
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const result = hotkeysSchema.safeParse(bindings)
    setSaved(false)
    if (!result.success) {
      setError(result.error.issues[0].message)
      return
    }
    setError('')
    setSaved(await command({ type: 'hotkeys', value: result.data }))
  }
  return (
    <div className="settings-layout">
      <section className="panel settings-main">
        <div className="section-heading">
          <span className="icon-tile">
            <Icon name="settings" />
          </span>
          <div>
            <h2>Global keyboard shortcuts</h2>
            <p className="muted">Control your session from any application.</p>
          </div>
        </div>
        <p className="muted">
          Use Ctrl+Alt plus one letter or number. Each action needs a different shortcut.
        </p>
        <form onSubmit={(event) => void save(event)}>
          {(['start', 'pause', 'stop'] as const).map((action) => (
            <label key={action} className="shortcut-field">
              <span>
                {action === 'pause'
                  ? 'Pause / Resume'
                  : action === 'start'
                    ? 'Start session'
                    : 'Stop session'}
                <small>
                  {action === 'start'
                    ? 'Opens setup and consent'
                    : action === 'pause'
                      ? 'Releases or reopens audio devices'
                      : 'Ends the current session'}
                </small>
              </span>
              <input
                aria-label={
                  action === 'pause'
                    ? 'Pause / Resume shortcut'
                    : `${action === 'start' ? 'Start' : 'Stop'} shortcut`
                }
                value={bindings[action]}
                disabled={busy}
                onChange={(event) => {
                  setBindings({ ...bindings, [action]: event.target.value })
                  setSaved(false)
                }}
              />
            </label>
          ))}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {snapshot.hotkeyErrors.map((message, index) => (
            <p className="error" role="alert" key={`${index}-${message}`}>
              {message}
            </p>
          ))}
          <div className="form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBindings({ ...defaultHotkeys })
                setSaved(false)
                setError('')
              }}
            >
              Reset to defaults
            </button>
            <button className="primary" disabled={busy} type="submit">
              <Icon name="check" />
              Save shortcuts
            </button>
          </div>
        </form>
        {saved && (
          <p className="success" role="status">
            Shortcuts saved.
          </p>
        )}
        <div className="active-shortcuts">
          <small>Registered shortcuts</small>
          <div>
            {snapshot.activeHotkeys.length ? (
              snapshot.activeHotkeys.map((key) => <kbd key={key}>{key}</kbd>)
            ) : (
              <span>No shortcuts registered. Use the tray menu.</span>
            )}
          </div>
        </div>
      </section>
      <aside className="settings-aside">
        <section className="panel">
          <h2>Floating overlay</h2>
          <p className="muted">Always on top, with room for your meeting.</p>
          <OpacitySetting snapshot={snapshot} command={command} />
          <button
            className="full-width"
            disabled={!snapshot.ready}
            onClick={() => void command({ type: 'show-overlay' })}
          >
            <Icon name="overlay" />
            Show overlay
          </button>
          <p className="field-help">
            Drag anywhere except controls and the scrollbar. Collapse keeps Pause, Stop, and Expand available.
          </p>
        </section>
        <section className="panel">
          <span className="icon-tile">
            <Icon name="shield" />
          </span>
          <h2>On this device</h2>
          <p className="muted">{snapshot.engine.message}</p>
          <div className="setting-readout">
            <span>Appearance</span>
            <strong>Light</strong>
          </div>
          <div className="setting-readout">
            <span>Processing</span>
            <strong>{snapshot.mode === 'demo' ? 'Written sample' : 'Local speech'}</strong>
          </div>
          <p className="field-help">
            Saved meeting storage, AI notes, and export settings will be available when those features are
            implemented.
          </p>
        </section>
      </aside>
    </div>
  )
}
