import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Phase5Request, Phase5Result } from '../../shared/phase5'
import { timestamp } from './ui/session'

/** Shared tools content, embedded in the main workspace sidebar navigation. */
export function Phase5Tools({ embedded = false, demo = false }: { embedded?: boolean; demo?: boolean }) {
  const [overview, setOverview] = useState<Phase5Result | null>(null)
  const [detail, setDetail] = useState<Phase5Result | null>(null)
  const [answer, setAnswer] = useState<Phase5Result | null>(null)
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:4319/vinxa/decisions')
  const [recordId, setRecordId] = useState('demo-client')
  const [speech, setSpeech] = useState({ language: 'en' as 'en'|'hi', model: 'base.en' as 'tiny.en'|'base.en'|'small', vadThreshold: 0.5, vadRelease: 0.35 })
  async function refresh() {
    const value = await window.vinxaPhase5.request({ type: 'overview' })
    setOverview(value)
    if (value.speech) setSpeech(value.speech)
  }
  async function run(input: Phase5Request) {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const value = await window.vinxaPhase5.request(input)
      setMessage(value.message)
      if (input.type === 'ask') setAnswer(value)
      if (input.type === 'detail') setDetail(value)
      if (['detect','speech','encryption'].includes(input.type)) await refresh()
      if (id && ['crm','remove-bookmark','bookmark','cluster'].includes(input.type)) setDetail(await window.vinxaPhase5.request({ type: 'detail', id }))
    } catch (error) { setError(error instanceof Error ? error.message : 'Operation failed.') }
    finally { setBusy(false) }
  }
  useEffect(() => { if (!demo) void refresh().catch(e => setError(String(e))) }, [demo])
  useEffect(() => { if (id) void run({ type: 'detail', id }); else setDetail(null) }, [id])
  function submit(event: FormEvent, input: Phase5Request) { event.preventDefault(); void run(input) }
  if (demo) return <section className="panel empty-state"><h2>Tools need a local recording</h2>
    <p>Demo mode uses written sample text. Run Vinxa with the local backend to use saved bookmarks, Ask Vinxa and integrations.</p></section>
  return <section className={embedded ? 'tools-content' : 'workspace'} aria-label="Meeting tools">
    {!embedded &&
    <div className="page-heading"><div><p className="eyebrow">VINXA OPTIONAL TOOLS</p><h1>Meeting tools</h1>
      <p className="muted">Bookmarks, transcript evidence, and optional meeting features.</p></div></div>}
    {error && <p className="error message" role="alert">{error}</p>}
    <p role="status">{busy ? 'Working…' : message}</p>
    <fieldset disabled={busy}>
      <legend>Saved session tools</legend>
      <label>Meeting <select value={id} onChange={e => setId(e.target.value)}><option value="">Choose a meeting</option>
        {overview?.meetings?.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
      <button onClick={() => { void refresh().catch(e => setError(String(e))); if (id) void run({ type: 'detail', id }) }}>Refresh sessions</button>
      <section className="panel"><h2>Live bookmarks</h2>
        <p>Press Ctrl+Alt+B during recording, or use the tray menu. Paused and stopped sessions cannot add moments.</p>
        <button onClick={() => void run({ type: 'bookmark' })}>Bookmark current recording</button>
        {!detail?.bookmarks?.length && <p>No bookmarks for the selected meeting.</p>}
        <ul>{detail?.bookmarks?.map(b => <li key={b.id}>
          <button onClick={() => void run({ type: 'open-passage', id: b.meetingId, atMs: b.atMs })}>{timestamp(b.atMs)} · {b.note}</button>{' '}
          <button aria-label={'Remove bookmark at ' + timestamp(b.atMs)} onClick={() => void run({ type: 'remove-bookmark', id: b.id })}>Remove</button>
        </li>)}</ul>
      </section>
      <section className="panel"><h2>Mock CRM</h2><p>Local demo only. Review the generated notes before sending. Audio and transcript are excluded.</p>
        <form onSubmit={e => submit(e, { type: 'crm', id, endpoint, recordId })}>
          <label>Local endpoint<input type="url" required value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
          <label>CRM record<input required maxLength={120} value={recordId} onChange={e => setRecordId(e.target.value)} /></label>
          <button disabled={!id}>Review and send</button>
        </form>
        <p>Last attempt per record and endpoint. Stale means saved notes changed after sending.</p>
        <ul>{detail?.crm?.map((c,i) => <li key={i}>{c.recordId} · {c.status}{c.sentAt ? ' · ' + new Date(c.sentAt).toLocaleString() : ''}</li>)}</ul>
      </section>
      <section className="panel"><h2>Remote speaker clustering</h2>
        <p>Runs locally on saved system audio using optional Sherpa ONNX models. Labels are estimates, not identities. Mixed passages retain Remote.</p>
        <button disabled={!id} onClick={() => void run({ type: 'cluster', id })}>Cluster selected meeting</button>
      </section>
      <section className="panel"><h2>Ask Vinxa</h2><p>Find exact transcript evidence across saved meetings. No cloud or generative model is used.</p>
        <form onSubmit={e => submit(e, { type: 'ask', question })}>
          <label>Question<input required maxLength={500} value={question} onChange={e => setQuestion(e.target.value)} /></label><button>Find evidence</button>
        </form>
        {answer && <p>{answer.message}</p>}
        {answer?.passages?.map(p => <article className="segment" key={p.meetingId+p.segmentId}><div>
          <button onClick={() => void run({ type: 'open-passage', id: p.meetingId, atMs: p.atMs })}>{p.title} · {p.speaker} · {timestamp(p.atMs)}</button>
          <p>{p.text}</p></div></article>)}
      </section>
      <section className="panel"><h2>Meeting detection</h2>
        <label className="check"><input type="checkbox" checked={overview?.detecting ?? false} onChange={e => void run({ type: 'detect', enabled: e.target.checked })} />Offer recording when a Zoom/Teams call window appears</label>
        <p>Window-title hints can miss calls or give false positives. Meet/browser calls remain manual. Consent is always required.</p>
      </section>
      <section className="panel"><h2>Encrypted local storage</h2><p>{overview?.encryption ?? 'Checking Windows EFS…'}</p>
        <p>EFS requires a supported Windows edition and NTFS volume. Back up your encryption certificate with cipher /x. Exports are outside the profile’s protection.</p>
        <button onClick={() => void run({ type: 'encryption' })}>Enable EFS on next launch</button>
      </section>
      <section className="panel"><h2>Speech configuration</h2><p>Applies after quitting and reopening. Multilingual Hindi/English requires the small model; install models before selecting them.</p>
        <form onSubmit={e => submit(e, { type: 'speech', value: speech })}>
          <label>Model<select value={speech.model} onChange={e => setSpeech({ ...speech, model: e.target.value as typeof speech.model })}>
            <option>tiny.en</option><option>base.en</option><option>small</option></select></label>
          <label>Language<select value={speech.language} onChange={e => setSpeech({ ...speech, language: e.target.value as 'en'|'hi' })}><option value="en">English</option><option value="hi">Hindi / Hindi-English</option></select></label>
          <label>VAD onset<input type="number" min="0.1" max="0.95" step="0.05" value={speech.vadThreshold} onChange={e => setSpeech({ ...speech, vadThreshold: Number(e.target.value) })} /></label>
          <label>VAD release<input type="number" min="0.05" max="0.9" step="0.05" value={speech.vadRelease} onChange={e => setSpeech({ ...speech, vadRelease: Number(e.target.value) })} /></label>
          <button>Save speech configuration</button>
        </form>
      </section>
    </fieldset>
  </section>
}
