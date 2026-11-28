import { useState } from 'react'
import type { Phase2Snapshot } from '../../../shared/phase2'
import { Icon } from './Icon'
import { Transcript } from './Transcript'
import { SavedMeetings } from './SavedMeetings'
import type { SearchResult } from '../../../shared/phase4'

export function Library({ snapshot, target }: { snapshot: Phase2Snapshot; target?: SearchResult | null }) {
  return snapshot.mode === 'demo' ? <DemoLibrary snapshot={snapshot} /> : <SavedMeetings openTarget={target} />
}

function DemoLibrary({ snapshot }: { snapshot: Phase2Snapshot }) {
  const [details, setDetails] = useState(false)
  const [tab, setTab] = useState('Transcript')
  if (details && snapshot.sessionId)
    return (
      <div className="meeting-details">
        <button className="back-button" onClick={() => setDetails(false)}>
          <Icon name="arrow" />
          Back to library
        </button>
        <section className="panel details-card">
          <div className="section-heading">
            <span className="icon-tile">
              <Icon name="transcript" />
            </span>
            <div>
              <p className="eyebrow">CURRENT SESSION · NOT SAVED</p>
              <h2>{snapshot.config.title}</h2>
            </div>
          </div>
          <p className="muted">
            {snapshot.segments.length} transcript entries ·{' '}
            {snapshot.mode === 'demo' ? 'Written sample' : 'Local transcription'}
          </p>
          <div className="detail-tabs" role="tablist" aria-label="Meeting details">
            {['Transcript', 'Summary', 'Decisions', 'Action items'].map((name) => (
              <button
                key={name}
                role="tab"
                id={`tab-${name.replaceAll(' ', '-')}`}
                aria-selected={tab === name}
                tabIndex={tab === name ? 0 : -1}
                aria-controls="detail-panel"
                onClick={() => setTab(name)}
                onKeyDown={(event) => {
                  const tabs = ['Transcript', 'Summary', 'Decisions', 'Action items']
                  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                  if (!direction && !['Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : (tabs.indexOf(name) + direction + tabs.length) % tabs.length
                  setTab(tabs[next])
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus()
                }}
              >
                {name}
                {name !== 'Transcript' && <span className="future-label">Future</span>}
              </button>
            ))}
          </div>
          <div id="detail-panel" role="tabpanel" aria-labelledby={`tab-${tab.replaceAll(' ', '-')}`}>
            {tab === 'Transcript' ? (
              <Transcript snapshot={snapshot} />
            ) : (
              <div className="empty-state">
                <span className="empty-icon">
                  <Icon name="info" />
                </span>
                <h3>{tab} — coming in a later phase</h3>
                <p>
                  Meeting intelligence is not connected yet. No generated content is available for this
                  session.
                </p>
              </div>
            )}
          </div>
        </section>
        <p className="notice">
          <Icon name="info" />
          This session is held in memory. It is replaced when a new session starts and is cleared when Vinxa
          quits.
        </p>
      </div>
    )
  return (
    <div className="library-layout">
      <div className="library-search">
        <Icon name="search" />
        <input
          aria-label="Search saved meetings"
          type="search"
          disabled
          placeholder="Saved-meeting search is not available yet"
        />
        <span className="badge">Future phase</span>
      </div>
      {snapshot.sessionId && (
        <section className="panel current-meeting">
          <span className="icon-tile">
            <Icon name="transcript" />
          </span>
          <div>
            <p className="eyebrow">CURRENT SESSION · NOT SAVED</p>
            <h2>{snapshot.config.title}</h2>
            <p className="muted">{snapshot.segments.length} entries · Available while Vinxa remains open</p>
          </div>
          <button
            onClick={() => {
              setDetails(true)
              setTab('Transcript')
            }}
          >
            View session
          </button>
        </section>
      )}
      <section className="panel empty-state library-empty">
        <span className="empty-icon">
          <Icon name="library" />
        </span>
        <h2>No saved meetings yet</h2>
        <p>
          The library design is ready. Persistent meeting storage, saved-meeting search, rename, export, and
          delete are planned for a later phase.
        </p>
        <small>Your current live transcript is available on the dashboard.</small>
      </section>
    </div>
  )
}
