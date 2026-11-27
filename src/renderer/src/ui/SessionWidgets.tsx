import type { Phase2Snapshot } from '../../../shared/phase2'
import { Icon } from './Icon'
import type { CommandHandler } from './session'

export function StatusBadge({ snapshot }: { snapshot: Phase2Snapshot }) {
  const label =
    snapshot.busy && snapshot.state === 'awaiting-consent' ? 'Starting…' : snapshot.state.replaceAll('-', ' ')
  return (
    <span className={`status ${snapshot.state}`} role="status">
      <span className="status-dot" />
      {label}
    </span>
  )
}

export function ModeBadge({ snapshot }: { snapshot: Phase2Snapshot }) {
  return (
    <span className={`badge ${snapshot.mode === 'demo' ? 'demo-badge' : 'local-badge'}`}>
      {snapshot.mode === 'demo' ? (
        'Demo'
      ) : (
        <>
          <Icon name="shield" />
          Local
        </>
      )}
    </span>
  )
}

export function SessionControls({
  snapshot,
  command,
  busy,
  compact = false
}: {
  snapshot: Phase2Snapshot
  command: CommandHandler
  busy: boolean
  compact?: boolean
}) {
  const active = ['recording', 'paused'].includes(snapshot.state)
  const canStart = ['idle', 'completed', 'error', 'interrupted'].includes(snapshot.state)
  return (
    <div className={`controls ${compact ? 'compact-controls' : ''}`}>
      {!compact && (
        <button
          className="primary start-button"
          disabled={!canStart || busy || !snapshot.engine.ready}
          onClick={() => void command({ type: 'start' })}
        >
          <Icon name="play" />
          {snapshot.mode === 'demo' ? 'Start demo' : 'Start session'}
        </button>
      )}
      <button disabled={!active || busy} onClick={() => void command({ type: 'pause-resume' })}>
        <Icon name={snapshot.state === 'paused' ? 'play' : 'pause'} />
        {snapshot.state === 'paused' ? 'Resume' : 'Pause'}
      </button>
      <button
        className="danger"
        disabled={!(active || snapshot.state === 'awaiting-consent') || busy}
        onClick={() => void command({ type: 'stop' })}
      >
        <Icon name="stop" />
        Stop
      </button>
    </div>
  )
}

export function AudioCard({ source, snapshot }: { source: 'mic' | 'system'; snapshot: Phase2Snapshot }) {
  const mic = source === 'mic'
  const enabled = mic ? snapshot.config.microphoneEnabled : snapshot.config.systemAudioEnabled
  const value = snapshot.levels[source]
  const live = value !== null && snapshot.state === 'recording'
  const label = mic ? 'Microphone' : 'System audio'
  return (
    <article className="panel audio-card">
      <div className="audio-heading">
        <span className="icon-tile">
          <Icon name={mic ? 'mic' : 'speaker'} />
        </span>
        <div>
          <h2>{label}</h2>
          <p className="muted">
            {mic
              ? snapshot.config.microphoneDeviceId
                ? 'Selected microphone'
                : 'System default microphone'
              : 'Windows default output'}
          </p>
        </div>
        <span className="source-state">
          {!enabled ? 'Off' : live ? 'Live' : snapshot.state === 'paused' ? 'Paused' : 'Inactive'}
        </span>
      </div>
      <div className="meter-line">
        <meter min={0} max={1} value={value ?? 0} aria-label={`${label} audio level`} />
        <small>{snapshot.mode === 'demo' ? 'Demo' : live ? 'Live' : 'No capture'}</small>
      </div>
    </article>
  )
}

export function ShortcutHints({ snapshot }: { snapshot: Phase2Snapshot }) {
  return (
    <section className="shortcut-hints">
      <h2>Keyboard shortcuts</h2>
      {(['start', 'pause', 'stop'] as const).map((action) => (
        <div className="shortcut-row" key={action}>
          <span>
            {action === 'pause' ? 'Pause / Resume' : action === 'start' ? 'Start session' : 'Stop session'}
          </span>
          <kbd
            className={snapshot.activeHotkeys.includes(snapshot.hotkeys[action]) ? '' : 'inactive-shortcut'}
          >
            {snapshot.hotkeys[action]}
          </kbd>
        </div>
      ))}
      {snapshot.hotkeyErrors.length > 0 && (
        <p className="error">Some shortcuts are unavailable. Check Settings.</p>
      )}
    </section>
  )
}
