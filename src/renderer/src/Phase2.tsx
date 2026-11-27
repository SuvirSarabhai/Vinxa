import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { RecordingConfig } from '../../shared/contracts'
import { hotkeysSchema } from '../../shared/phase2'
import { useOverlayDrag } from './use-overlay-drag'
import type { Hotkeys, Phase2Command, Phase2Snapshot } from '../../shared/phase2'

type CommandHandler = (command: Phase2Command) => Promise<void>

function timestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function Transcript({ snapshot }: { snapshot: Phase2Snapshot }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [snapshot.segments.length, snapshot.segments.at(-1)?.text])

  return (
    <div className="transcript" aria-label="Transcript">
      {snapshot.segments.length === 0 && <p className="muted">Transcript segments will appear here after consent.</p>}
      {snapshot.segments.map((segment) => (
        <article key={segment.id} className={segment.isFinal ? 'segment' : 'segment partial'}>
          <div className="segment-meta">
            <strong>{segment.source === 'mic' ? 'You' : 'Remote'}</strong>
            <time>{timestamp(segment.startMs)}</time>
            {!segment.isFinal && <span>Partial</span>}
          </div>
          <p>{segment.text}</p>
        </article>
      ))}
      {snapshot.pauses.map((gap, index) => (
        <p className="pause-gap" key={index}>
          Paused: {timestamp(gap.startMs)} — {gap.endMs === null ? 'in progress' : timestamp(gap.endMs)}
        </p>
      ))}
      <div ref={end} />
    </div>
  )
}

function LevelMeter({ label, value, enabled }: { label: string; value: number | null; enabled: boolean }) {
  return (
    <label className="level">
      <span>{label}</span>
      <meter min={0} max={1} value={value ?? 0} aria-label={`${label} audio level`} />
      <small>{!enabled ? 'Source disabled' : value === null ? 'No live audio level connected' : 'Live'}</small>
    </label>
  )
}

function SessionControls({ snapshot, command, busy }: { snapshot: Phase2Snapshot; command: CommandHandler; busy: boolean }) {
  const active = snapshot.state === 'recording' || snapshot.state === 'paused'
  const canStart = ['idle', 'completed', 'error'].includes(snapshot.state)
  return (
    <div className="controls">
      <button disabled={!canStart || busy} onClick={() => void command({ type: 'start' })}>
        Start {snapshot.mode === 'demo' ? 'demo' : 'recording'}
      </button>
      <button disabled={!active || busy} onClick={() => void command({ type: 'pause-resume' })}>
        {snapshot.state === 'paused' ? 'Resume' : 'Pause'}
      </button>
      <button disabled={!active} onClick={() => void command({ type: 'stop' })}>Stop</button>
    </div>
  )
}

function Setup({ snapshot, command, busy }: { snapshot: Phase2Snapshot; command: CommandHandler; busy: boolean }) {
  const [config, setConfig] = useState<RecordingConfig>(snapshot.config)
  const [consent, setConsent] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceMessage, setDeviceMessage] = useState('Device names may stay hidden until Windows grants microphone access. No microphone access is requested in this demo.')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const media = navigator.mediaDevices
    async function refresh(): Promise<void> {
      if (!media?.enumerateDevices) {
        setDeviceMessage('Device discovery is unavailable. Use System default.')
        return
      }
      try {
        const available = await media.enumerateDevices()
        if (!cancelled) setDevices(available.filter((device) => device.kind === 'audioinput' && device.deviceId))
      } catch {
        if (!cancelled) setDeviceMessage('Device names are unavailable. Use System default.')
      }
    }
    void refresh()
    media?.addEventListener('devicechange', refresh)
    return () => { cancelled = true; media?.removeEventListener('devicechange', refresh) }
  }, [])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (consent) void command({ type: 'confirm', config, consent: true })
  }

  return (
    <main className="shell setup">
      <p className="eyebrow">SETUP AND CONSENT</p>
      <h1>Start a session</h1>
      {snapshot.mode === 'demo' && <p className="notice">Demo mode uses written sample segments. No microphone or system audio is captured.</p>}
      <form onSubmit={submit}>
        <label className="field">Meeting title
          <input required maxLength={160} value={config.title} disabled={busy}
            onChange={(event) => setConfig({ ...config, title: event.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={config.microphoneEnabled} disabled={busy}
            onChange={(event) => setConfig({ ...config, microphoneEnabled: event.target.checked })} />
          Include microphone
        </label>
        <label className="field">Microphone
          <select value={config.microphoneDeviceId ?? ''} disabled={!config.microphoneEnabled || busy}
            onChange={(event) => setConfig({ ...config, microphoneDeviceId: event.target.value || null })}>
            <option value="">System default</option>
            {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
          </select>
        </label>
        <p className="muted">{deviceMessage}</p>
        <label className="check">
          <input type="checkbox" checked={config.systemAudioEnabled} disabled={busy}
            onChange={(event) => setConfig({ ...config, systemAudioEnabled: event.target.checked })} />
          Include system audio
        </label>
        <div className="levels">
          <LevelMeter label="Microphone" value={snapshot.levels.mic} enabled={config.microphoneEnabled} />
          <LevelMeter label="System audio" value={snapshot.levels.system} enabled={config.systemAudioEnabled} />
        </div>
        <p>With the local backend connected, the selected microphone and meeting audio will be captured and stored on this laptop. Cloud processing is not connected in this build.</p>
        <button type="button" disabled={busy} onClick={async () => {
          await command({ type: 'copy-announcement' })
          setCopied(true)
        }}>Copy meeting announcement</button>
        {copied && <p role="status" className="muted">Announcement copy requested. Paste it into the meeting chat after reviewing it.</p>}
        <label className="check consent">
          <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />
          I confirm that participants have been informed and consent has been obtained.
        </label>
        <div className="controls">
          <button type="submit" disabled={busy || !consent || !config.title.trim() || (!config.microphoneEnabled && !config.systemAudioEnabled)}>
            Confirm and start {snapshot.mode === 'demo' ? 'demo' : ''}
          </button>
          <button type="button" onClick={() => void command({ type: 'cancel' })}>Cancel</button>
        </div>
      </form>
    </main>
  )
}

function ShortcutSettings({ snapshot, command, busy }: { snapshot: Phase2Snapshot; command: CommandHandler; busy: boolean }) {
  const [bindings, setBindings] = useState<Hotkeys>(snapshot.hotkeys)
  const [error, setError] = useState('')
  useEffect(() => { setBindings(snapshot.hotkeys) }, [snapshot.hotkeys.start, snapshot.hotkeys.pause, snapshot.hotkeys.stop])

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const result = hotkeysSchema.safeParse(bindings)
    if (!result.success) { setError(result.error.issues[0].message); return }
    setError('')
    void command({ type: 'hotkeys', value: result.data })
  }

  return (
    <section className="panel">
      <h2>Hotkey settings</h2>
      <p className="muted">Use Ctrl+Alt plus one letter or number. Each shortcut must be different.</p>
      <form onSubmit={save}>
        {(['start', 'pause', 'stop'] as const).map((action) => (
          <label key={action} className="field">{action === 'pause' ? 'Pause / Resume' : action === 'start' ? 'Start' : 'Stop'}
            <input value={bindings[action]} disabled={busy} onChange={(event) => setBindings({ ...bindings, [action]: event.target.value })} />
          </label>
        ))}
        <button disabled={busy} type="submit">Save hotkeys</button>
      </form>
      <p className="muted">Active: {snapshot.activeHotkeys.length ? snapshot.activeHotkeys.join(', ') : 'None — use the tray menu until valid shortcuts are saved.'}</p>
      {error && <p role="alert">{error}</p>}
      {snapshot.hotkeyErrors.map((message, index) => <p role="alert" key={`${index}-${message}`}>{message}</p>)}
    </section>
  )
}

export function Phase2App() {
  const [snapshot, setSnapshot] = useState<Phase2Snapshot | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(0)
  const route = window.location.hash.slice(1)
  const dragHandlers = useOverlayDrag(route === 'overlay')

  useEffect(() => {
    const api = window.vinxaPhase2
    if (!api) { setError('Desktop bridge unavailable. Restart Vinxa.'); return }
    let cancelled = false
    const accept = (incoming: Phase2Snapshot): void => {
      if (!cancelled) setSnapshot((previous) => !previous || incoming.revision >= previous.revision ? incoming : previous)
    }
    const unsubscribe = api.onChange(accept)
    void api.snapshot().then(accept).catch(() => { if (!cancelled) setError('Could not load the session. Restart Vinxa.') })
    return () => { cancelled = true; unsubscribe() }
  }, [])

  async function command(value: Phase2Command): Promise<void> {
    setPending((previous) => previous + 1)
    setError('')
    try { await window.vinxaPhase2.command(value) }
    catch { setError('The action could not be completed. Check the session message or try again.') }
    finally { setPending((previous) => previous - 1) }
  }

  if (!snapshot) return <main className="shell"><p role="status">{error || 'Loading Vinxa…'}</p></main>
  const busy = !snapshot.ready || snapshot.busy || pending > 0
  const message = snapshot.error || error

  if (route === 'setup') return (
    <>
      {message && <p className="error" role="alert">{message}</p>}
      <Setup key={snapshot.consentRequest} snapshot={snapshot} command={command} busy={busy} />
    </>
  )

  if (route === 'overlay') return (
    <main className="overlay-shell" {...dragHandlers}>
      <header className="overlay-drag">
        <strong>{snapshot.mode === 'demo' ? 'VINXA DEMO' : 'VINXA'}</strong>
        <span className={`status ${snapshot.state}`} role="status">{snapshot.state}</span>
        <button onClick={() => void command({ type: 'collapse' })}>{snapshot.collapsed ? 'Expand' : 'Collapse'}</button>
      </header>
      {!snapshot.collapsed && <div className="overlay-body">
        <SessionControls snapshot={snapshot} command={command} busy={busy} />
        <div className="overlay-tools">
          <label className="field">Opacity
            <input aria-label="Overlay opacity" type="range" min={50} max={100} value={Math.round(snapshot.opacity * 100)}
              onChange={(event) => void command({ type: 'opacity', value: Number(event.target.value) / 100 })} />
          </label>
          <button onClick={() => void command({ type: 'copy-lines' })}>Copy recent lines</button>
        </div>
        {message && <p role="alert">{message}</p>}
        <p className="muted">{snapshot.notice}</p>
        <Transcript snapshot={snapshot} />
      </div>}
    </main>
  )

  return (
    <main className="shell">
      <header className="toolbar">
        <p className="eyebrow">VINXA / PHASE 2</p>
        <span className={`status ${snapshot.state}`} role="status">{snapshot.mode === 'demo' ? 'DEMO · ' : ''}{snapshot.state}</span>
      </header>
      <h1>Your meetings, remembered.</h1>
      <p className="notice">{snapshot.mode === 'demo' ? 'Demo backend: written sample transcript only. No audio is recorded.' : 'Local recording backend connected.'}</p>
      {!snapshot.ready && <p role="status">Loading hotkey settings…</p>}
      <SessionControls snapshot={snapshot} command={command} busy={busy} />
      <button disabled={!snapshot.ready} onClick={() => void command({ type: 'show-overlay' })}>Show floating overlay</button>
      {message && <p className="error" role="alert">{message}</p>}
      <section className="panel">
        <h2>{snapshot.config.title}</h2>
        <p className="muted">{snapshot.notice}</p>
        <div className="levels">
          <LevelMeter label="Microphone" value={snapshot.levels.mic} enabled={snapshot.config.microphoneEnabled} />
          <LevelMeter label="System audio" value={snapshot.levels.system} enabled={snapshot.config.systemAudioEnabled} />
        </div>
        <Transcript snapshot={snapshot} />
      </section>
      <ShortcutSettings snapshot={snapshot} command={command} busy={busy} />
      <footer>The sample is short. Stop ends the demo session. Meeting history, exports, and AI notes are not connected yet.</footer>
    </main>
  )
}
