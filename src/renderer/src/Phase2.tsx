import { useState } from 'react'
import type { Phase2Snapshot } from '../../shared/phase2'
import { useOverlayDrag } from './use-overlay-drag'
import { Icon } from './ui/Icon'
import { Transcript } from './ui/Transcript'
import { Setup } from './ui/Setup'
import { Settings, OpacitySetting } from './ui/Settings'
import { Library } from './ui/Library'
import { AudioCard, ModeBadge, SessionControls, ShortcutHints, StatusBadge } from './ui/SessionWidgets'
import { useDuration, useSession } from './ui/session'
import type { CommandHandler } from './ui/session'

function CopyLines({ snapshot, command }: { snapshot: Phase2Snapshot; command: CommandHandler }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      disabled={!snapshot.segments.some((segment) => segment.isFinal)}
      onClick={async () => {
        if (await command({ type: 'copy-lines' })) {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? 'Copied' : 'Copy recent lines'}
    </button>
  )
}

function Overlay({
  snapshot,
  command,
  busy,
  error
}: {
  snapshot: Phase2Snapshot
  command: CommandHandler
  busy: boolean
  error: string
}) {
  const dragHandlers = useOverlayDrag(true)
  const duration = useDuration(snapshot)
  return (
    <main className={`overlay-shell ${snapshot.collapsed ? 'is-collapsed' : ''}`} {...dragHandlers}>
      <header className="overlay-drag">
        <span className="overlay-brand">
          <Icon name="wave" />
          <strong>Vinxa</strong>
        </span>
        <ModeBadge snapshot={snapshot} />
        <StatusBadge snapshot={snapshot} />
        <time className="duration-small">{duration}</time>
        <button
          className="icon-button"
          aria-label="Open main window"
          title="Open main window"
          onClick={() => void command({ type: 'open-library' })}
        >
          <Icon name="dashboard" />
        </button>
        {!snapshot.collapsed && (
          <button
            className="icon-button"
            aria-label="Collapse"
            title="Collapse"
            onClick={() => void command({ type: 'collapse' })}
          >
            <Icon name="collapse" />
          </button>
        )}
      </header>
      {snapshot.collapsed ? (
        <div className="collapsed-controls">
          <SessionControls snapshot={snapshot} command={command} busy={busy} compact />
          <button className="primary" onClick={() => void command({ type: 'collapse' })}>
            <Icon name="expand" />
            Expand
          </button>
          {error && (
            <span className="error collapsed-error" role="alert">
              {error}
            </span>
          )}
        </div>
      ) : (
        <div className="overlay-body">
          <div className="overlay-session-bar">
            <SessionControls snapshot={snapshot} command={command} busy={busy} compact />
            <span className="muted">
              {snapshot.mode === 'demo' ? 'Written sample · no audio captured' : 'Live local transcript'}
            </span>
          </div>
          {error && (
            <p className="error message" role="alert">
              {error}
            </p>
          )}
          <p className="overlay-notice">{snapshot.notice}</p>
          <Transcript snapshot={snapshot} />
          <footer className="overlay-footer">
            <CopyLines snapshot={snapshot} command={command} />
            <OpacitySetting snapshot={snapshot} command={command} />
          </footer>
        </div>
      )}
    </main>
  )
}

function Dashboard({
  snapshot,
  command,
  busy
}: {
  snapshot: Phase2Snapshot
  command: CommandHandler
  busy: boolean
}) {
  const duration = useDuration(snapshot)
  return (
    <div className="dashboard-grid">
      <aside className="dashboard-sidebar">
        <section className="panel session-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">CURRENT SESSION</p>
              <h2>{snapshot.config.title}</h2>
            </div>
            <span className="icon-tile">
              <Icon name="wave" />
            </span>
          </div>
          <div className="duration-row">
            <time className="session-duration">{duration}</time>
            <StatusBadge snapshot={snapshot} />
          </div>
          <SessionControls snapshot={snapshot} command={command} busy={busy} />
          <button
            className="full-width"
            disabled={!snapshot.ready}
            onClick={() => void command({ type: 'show-overlay' })}
          >
            <Icon name="overlay" />
            Show overlay
          </button>
          <p className="session-caption">
            {snapshot.mode === 'demo'
              ? 'Try the controls with a written sample.'
              : 'Start with consent. Pause whenever you need.'}
          </p>
        </section>
        <AudioCard source="mic" snapshot={snapshot} />
        <AudioCard source="system" snapshot={snapshot} />
        <ShortcutHints snapshot={snapshot} />
      </aside>
      <section className="panel transcript-panel">
        <header className="transcript-heading">
          <div>
            <h2>Live transcript</h2>
            <p className="muted">
              {snapshot.mode === 'demo'
                ? 'Written sample · no audio is captured'
                : 'On-device speech recognition · no cloud processing'}
            </p>
          </div>
          <span className="entry-count">{snapshot.segments.length} entries</span>
        </header>
        <Transcript snapshot={snapshot} />
        <footer className="transcript-footer">
          <span>
            <Icon name="shield" />
            {snapshot.mode === 'demo' ? 'Sample transcript' : 'Processed on this device'}
          </span>
          <CopyLines snapshot={snapshot} command={command} />
        </footer>
      </section>
    </div>
  )
}

export function Phase2App() {
  const { snapshot, command, busy, error } = useSession()
  const [view, setView] = useState<'dashboard' | 'library' | 'settings'>('dashboard')
  const route = window.location.hash.slice(1)
  if (!snapshot)
    return (
      <main className="loading-shell">
        <span className="brand-mark">
          <Icon name="wave" />
        </span>
        <h1>Vinxa</h1>
        <p role="status">{error || 'Preparing your workspace…'}</p>
      </main>
    )
  if (route === 'setup')
    return (
      <Setup key={snapshot.consentRequest} snapshot={snapshot} command={command} busy={busy} error={error} />
    )
  if (route === 'overlay') return <Overlay snapshot={snapshot} command={command} busy={busy} error={error} />
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="wave" />
          </span>
          <strong>Vinxa</strong>
          <ModeBadge snapshot={snapshot} />
        </div>
        <nav aria-label="Main navigation">
          {(['dashboard', 'library', 'settings'] as const).map((name) => (
            <button
              key={name}
              aria-current={view === name ? 'page' : undefined}
              onClick={() => setView(name)}
            >
              <Icon name={name} />
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
        </nav>
        <span className={`engine-indicator ${snapshot.engine.ready ? 'engine-ready' : ''}`} role="status">
          <span className="status-dot" />
          {snapshot.engine.ready
            ? snapshot.mode === 'demo'
              ? 'Demo ready'
              : 'Local engine ready'
            : 'Preparing local speech…'}
        </span>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR LOCAL MEETING WORKSPACE</p>
            <h1>
              {view === 'dashboard'
                ? 'Your meetings, remembered.'
                : view === 'settings'
                  ? 'Settings'
                  : 'Meeting library'}
            </h1>
            <p className="muted">
              {view === 'dashboard'
                ? 'Stay in the conversation. Keep the words that matter.'
                : view === 'settings'
                  ? 'Make Vinxa work the way you do.'
                  : 'A home for your meeting memory.'}
            </p>
          </div>
          {view === 'dashboard' && (
            <span className="privacy-tag">
              <Icon name="shield" />
              {snapshot.mode === 'demo' ? 'No audio captured' : 'On-device transcription'}
            </span>
          )}
        </div>
        {error && (
          <p className="error message" role="alert">
            <Icon name="info" />
            {error}
          </p>
        )}
        {view === 'dashboard' && (
          <div className="engine-message">
            <span className="status-dot" />
            <span role="status">{snapshot.engine.message}</span>
            <span className="session-notice">{snapshot.notice}</span>
          </div>
        )}
        {view === 'dashboard' ? (
          <Dashboard snapshot={snapshot} command={command} busy={busy} />
        ) : view === 'settings' ? (
          <Settings snapshot={snapshot} command={command} busy={busy} />
        ) : (
          <Library snapshot={snapshot} />
        )}
        <footer className="app-footer">
          <span>
            <Icon name="shield" />
            {snapshot.mode === 'demo'
              ? 'Demo mode uses sample text and does not open audio devices.'
              : 'Meeting-app mute does not mute Vinxa. Use Pause or Stop to end capture.'}
          </span>
          <span>Vinxa Desktop · Local meeting memory</span>
        </footer>
      </main>
    </div>
  )
}
