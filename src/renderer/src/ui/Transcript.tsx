import { useEffect, useRef } from 'react'
import type { Phase2Snapshot } from '../../../shared/phase2'
import { Icon } from './Icon'
import { timestamp } from './session'

export function Transcript({ snapshot }: { snapshot: Phase2Snapshot }) {
  const container = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const partialText = snapshot.segments
    .filter((segment) => !segment.isFinal)
    .map((segment) => segment.text)
    .join('\n')
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: 'nearest' })
  }, [
    snapshot.segments.length,
    snapshot.segments.at(-1)?.text,
    partialText,
    snapshot.pauses.length,
    snapshot.pauses.at(-1)?.endMs
  ])

  const entries = [
    ...snapshot.segments.map((segment) => ({
      at: segment.startMs,
      key: `text-${segment.id}`,
      element: (
        <article className={segment.isFinal ? 'segment' : 'segment partial'}>
          <time>{timestamp(segment.startMs)}</time>
          <div>
            <div className="segment-meta">
              <span className={`speaker ${segment.source}`}>
                {segment.source === 'mic' ? 'You' : 'Remote'}
              </span>
              {!segment.isFinal && <span className="partial-label">Partial</span>}
            </div>
            <p>{segment.text}</p>
          </div>
        </article>
      )
    })),
    ...snapshot.pauses.map((gap, index) => ({
      at: gap.startMs,
      key: `pause-${index}`,
      element: (
        <div className="pause-gap">
          <span>
            Paused · {timestamp(gap.startMs)} – {gap.endMs === null ? 'in progress' : timestamp(gap.endMs)}
          </span>
        </div>
      )
    }))
  ].sort((left, right) => left.at - right.at)

  return (
    <div
      className="transcript"
      aria-label="Transcript"
      ref={container}
      onScroll={() => {
        const element = container.current
        if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
      }}
    >
      {entries.length === 0 && (
        <div className="empty-state transcript-empty">
          <span className="empty-icon">
            <Icon name="transcript" />
          </span>
          <h3>
            {snapshot.state === 'recording'
              ? 'Listening for your first words'
              : 'Ready to transcribe locally'}
          </h3>
          <p>
            {snapshot.state === 'recording'
              ? 'Speech will appear here as provisional text, then settle into finalized lines.'
              : 'Start a session, review your audio sources, and confirm participant consent.'}
          </p>
          <small>
            {snapshot.mode === 'demo'
              ? 'Written sample transcript. No audio is captured.'
              : 'Your live transcript is processed on this laptop.'}
          </small>
        </div>
      )}
      {entries.map((entry) => (
        <div key={entry.key}>{entry.element}</div>
      ))}
      <div ref={end} />
    </div>
  )
}
