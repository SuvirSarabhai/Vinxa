import { useEffect, useRef, useState } from 'react'
import type { FixtureCommand, FixtureStatus, TranscriptSegment } from '../../shared/contracts'

export function App() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<FixtureStatus>('idle')
  const [error, setError] = useState('')
  const transcriptEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!window.vinxa) { setError('Desktop bridge unavailable. Restart Vinxa.'); return }
    const unsubscribeTranscript = window.vinxa.onTranscript((segment) => {
      setSegments((previous) => {
        const existing = previous.findIndex((entry) => entry.id === segment.id)
        return existing < 0 ? [...previous, segment] : previous.map((entry, index) => index === existing ? segment : entry)
      })
    })
    const unsubscribeStatus = window.vinxa.onFixtureStatus(setStatus)
    return () => { unsubscribeTranscript(); unsubscribeStatus() }
  }, [])

  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: 'nearest' }) }, [segments])

  async function controlFixture(command: FixtureCommand): Promise<void> {
    try {
      setError('')
      if (command === 'play' && status !== 'paused') setSegments([])
      await window.vinxa.fixtureCommand(command)
      if (command === 'stop') setSegments([])
    } catch {
      setError('Could not control the sample transcript. Restart Vinxa and try again.')
    }
  }

  return (
    <main className="shell">
      <header><p className="eyebrow">VINXA DESKTOP / PHASE 1</p><span className="badge">Not recording</span></header>
      <h1>Your meetings, remembered.</h1>
      <p className="copy">Preview a sample conversation. No microphone, system audio, or cloud service is used.</p>
      <section className="panel" aria-label="Sample transcript">
        <div className="toolbar">
          <h2>Transcript preview</h2>
          <span role="status">{status}</span>
        </div>
        <div className="controls">
          <button disabled={status === 'playing' || !window.vinxa} onClick={() => void controlFixture('play')}>
            {status === 'paused' ? 'Resume sample' : 'Play sample'}
          </button>
          <button disabled={status !== 'playing'} onClick={() => void controlFixture('pause')}>Pause sample</button>
          <button disabled={status === 'idle'} onClick={() => void controlFixture('stop')}>Reset sample</button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="transcript">
          {segments.length === 0 && <p className="muted">Play the sample to see both speakers, timestamps, and live text updates.</p>}
          {segments.map((segment) => (
            <article key={segment.id} className={segment.isFinal ? 'segment' : 'segment partial'}>
              <div className="segment-meta"><strong>{segment.source === 'mic' ? 'You' : 'Remote'}</strong>
                <time>{new Date(segment.startMs).toISOString().slice(14, 19)}</time>
                {!segment.isFinal && <span>Partial</span>}
              </div>
              <p>{segment.text}</p>
            </article>
          ))}
          <div ref={transcriptEnd} />
        </div>
      </section>
      <footer>Close the window to keep Vinxa in the tray. Use Open Library to return or Quit to exit.
        Recording controls become available when the capture pipeline is connected.</footer>
    </main>
  )
}

