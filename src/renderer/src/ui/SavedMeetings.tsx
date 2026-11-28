import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { LibraryData, MeetingDetail, MeetingCommand } from '../../../shared/meetings'
import { timestamp } from './session'
import { Icon } from './Icon'
import type { SearchResult } from '../../../shared/phase4'
import { MeetingSearch } from './MeetingSearch'
import { transcriptSpeaker } from '../../../shared/speaker-label'

function date(value: number): string { return new Date(value).toLocaleString() }
function message(error: unknown): string { return error instanceof Error ? error.message : 'Meeting data could not be loaded.' }

export function MeetingDetailView({ detail, command, busy, target }: {
  detail: MeetingDetail; command: (command: MeetingCommand) => Promise<void>; busy: boolean
  target?: SearchResult | null
}) {
  const [tab, setTab] = useState('Overview')
  const [title, setTitle] = useState(detail.meeting.title)
  const [names, setNames] = useState(detail.speakers)
  useEffect(() => { setTitle(detail.meeting.title); setNames(detail.speakers) }, [detail.meeting.id, detail.meeting.title, detail.speakers.mic, detail.speakers.system])
  const meeting = detail.meeting
  useEffect(() => { if (target) setTab(target.segmentId ? 'Transcript' : {Transcript:'Transcript',Summary:'Overview',Decision:'Decisions','Action item':'Actions'}[target.category]) }, [target])
  useEffect(() => {
    if (!target) return
    const timer=setTimeout(()=>document.getElementById('passage-'+(target.segmentId ?? target.targetId))?.scrollIntoView({block:'center',behavior:'instant'}),0)
    return()=>clearTimeout(timer)
  }, [target,tab])
  return <section className="panel details-card">
    <div className="section-heading"><span className="icon-tile"><Icon name="transcript" /></span>
      <div><h2>{meeting.title}</h2><p className="muted">{date(meeting.startedAt)} · {timestamp(meeting.duration)}</p></div>
    </div>
    <p role="status">Recording {meeting.recordingStatus} · Notes {meeting.notesStatus}</p>
    {meeting.error && <p className="error" role="alert">{meeting.error}</p>}
    {meeting.notesMessage && <p className="notice">{meeting.notesMessage}</p>}
    <div className="detail-tabs" role="tablist" aria-label="Saved meeting details">
      {['Overview', 'Transcript', 'Decisions', 'Actions'].map(name =>
            <button key={name} role="tab" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}
              onKeyDown={event => {
                const tabs = ['Overview', 'Transcript', 'Decisions', 'Actions']
                if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
                event.preventDefault()
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (tabs.indexOf(name)+(event.key === 'ArrowRight' ? 1 : -1)+tabs.length)%tabs.length
                setTab(tabs[index]); (event.currentTarget.parentElement?.children[index] as HTMLElement)?.focus()
              }}>{name}</button>)}
    </div>
    <div role="tabpanel" aria-label={tab}>
      {tab === 'Overview' && <>
        <form className="meeting-edit" onSubmit={(event: FormEvent) => { event.preventDefault(); void command({ type: 'rename', id: meeting.id, title }) }}>
          <label>Meeting title<input aria-label="Saved meeting title" value={title} maxLength={160} required onChange={event => setTitle(event.target.value)} /></label>
          <button disabled={busy || !title.trim()}>Rename meeting</button>
        </form>
        <h3>Summary</h3><p id={'passage-'+meeting.id} className={'notes-text '+(target?.category==='Summary'?'search-match':'')}>{detail.insights?.summary || (meeting.notesStatus === 'completed' ? 'No summary evidence was found.' : 'Notes are not available yet.')}</p>
        <button disabled={busy || meeting.recordingStatus !== 'completed' || meeting.notesStatus === 'processing'}
          onClick={() => void command({ type: 'notes', id: meeting.id })}>
          {meeting.notesStatus === 'processing' ? 'Generating notes…' : detail.insights ? 'Regenerate notes' : 'Generate notes'}
        </button>
        <h3>Speaker names</h3>
        {(['mic', 'system'] as const).map(source => <form key={source} className="meeting-edit" onSubmit={event => {
          event.preventDefault(); void command({ type: 'speaker', id: meeting.id, source, name: names[source] })
        }}>
          <label>{source === 'mic' ? 'Microphone speaker' : 'System audio speaker'}
            <input aria-label={source === 'mic' ? 'Microphone speaker name' : 'Remote speaker name'} maxLength={160} required
              value={names[source]} onChange={event => setNames({ ...names, [source]: event.target.value })} /></label>
          <button disabled={busy || !names[source].trim()}>Save name</button>
        </form>)}
        <p className="field-help">Display names apply to this meeting. Microphone and system source identities are retained.</p>
      </>}
      {tab === 'Transcript' && <div className="saved-transcript">
        {!detail.transcript.length && <p>No finalized transcript was captured.</p>}
        {detail.transcript.map(segment => <article id={'passage-'+segment.id} className={'segment '+(target?.segmentId===segment.id?'search-match':'')} key={segment.id}>
          <time>{timestamp(segment.startMs)}</time><div><strong>{transcriptSpeaker(segment,detail.speakers)}</strong>
            <p>{segment.text}</p></div>
        </article>)}
      </div>}
      {tab === 'Decisions' && <div>{!detail.insights?.decisions.length ? <p>No supported decisions are saved.</p> :
        <ul className="saved-items">{detail.insights.decisions.map((item, index) => <li id={target?.category==='Decision'&&target.atMs===item.atMs&&target.text===item.text?'passage-'+target.targetId:undefined} className={target?.category==='Decision'&&target.atMs===item.atMs&&target.text===item.text?'search-match':''} key={index}><time>{timestamp(item.atMs)}</time> {item.text}</li>)}</ul>}</div>}
      {tab === 'Actions' && <div>{!detail.actions.length ? <p>No action items are saved.</p> :
        <ul className="saved-items">{detail.actions.map(item => <li id={'passage-'+item.id} className={target?.targetId===item.id?'search-match':''} key={item.id}>
          <label className="check"><input type="checkbox" checked={item.status === 'done'} disabled={busy}
            onChange={event => void command({ type: 'action', id: meeting.id, actionId: item.id, status: event.target.checked ? 'done' : 'pending' })} />
            <span>{item.task}</span></label>
          <small>Owner {item.owner ?? 'Unassigned'} · Due {item.due ?? 'Unspecified'}</small>
        </li>)}</ul>}</div>}
    </div>
  </section>
}

export function SavedMeetings({ openTarget }: { openTarget?: SearchResult | null }) {
  const [target,setTarget]=useState<SearchResult|null>(null)
  const [library, setLibrary] = useState<LibraryData | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const selection = useRef(selected)
  selection.current = selected
  useEffect(() => {
    if (!openTarget) return
    selection.current = openTarget.meetingId
    setTarget(openTarget); setSelected(openTarget.meetingId)
  }, [openTarget])
  const [detail, setDetail] = useState<MeetingDetail | null>(null)
  const [error, setError] = useState('')
  const [notice,setNotice]=useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const selectedId = selection.current
    const sequence = ++request.current
    setLoading(true)
    try {
      const [data, saved] = await Promise.all([window.vinxaMeetings.list(), selectedId ? window.vinxaMeetings.get(selectedId) : Promise.resolve(null)])
      if (sequence !== request.current) return
      setLibrary(data); setDetail(saved); setError('')
    } catch (error) { if (sequence === request.current) setError(message(error)) }
    finally { if (sequence === request.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const off = window.vinxaMeetings.onChange(() => void refresh())
    return () => { request.current++; off() }
  }, [refresh, selected])
  async function command(value: MeetingCommand): Promise<void> {
    if (busy) return
    setBusy(true); setError('')
    try { await window.vinxaMeetings.command(value); await refresh() }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  async function manage(kind:'markdown'|'pdf'|'delete'|'recover'):Promise<void>{
    if(!selected||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      if(kind==='delete'){
        const result=await window.vinxaMeetings.deleteMeeting(selected)
        if(!result.cancelled){selection.current=null;setSelected(null);setDetail(null);setTarget(null);setNotice('Meeting permanently deleted.');await refresh()}
      }else if(kind==='recover'){await window.vinxaMeetings.recoverMeeting(selected);await refresh();setNotice('Committed meeting data recovered. Review any missing-data warnings.')}
      else{const result=await window.vinxaMeetings.exportMeeting({id:selected,format:kind});if(!result.cancelled)setNotice('Export saved: '+result.path)}
    }catch(error){await refresh();setError(message(error))}
    finally{setBusy(false)}
  }
  return <div className="library-layout">
    {!selected&&<MeetingSearch open={result=>{setTarget(result);setSelected(result.meetingId);setDetail(null)}}/>}
    <div className="library-toolbar">
      {selected && <button onClick={() => { setSelected(null); setDetail(null) }}>Back to library</button>}
      <button onClick={() => void refresh()} disabled={loading || busy}>Refresh</button>
      {selected&&<>
        <button disabled={busy||loading} onClick={()=>void manage('markdown')}>Export Markdown</button>
        <button disabled={busy||loading} onClick={()=>void manage('pdf')}>Export PDF</button>
        <button disabled={busy||loading} onClick={()=>void manage('delete')}>Delete meeting</button>
        {detail&&['interrupted','error'].includes(detail.meeting.recordingStatus)&&<button disabled={busy} onClick={()=>void manage('recover')}>Recover meeting</button>}
      </>}
      {library && <p>{library.stats.totalMeetings} meetings · {library.stats.pendingActions} pending actions</p>}
    </div>
    {error && <p className="error message" role="alert">{error}</p>}
    {notice&&<p className="notice" role="status">{notice}</p>}
    {loading && <p role="status">Loading saved meetings…</p>}
    {selected ? detail && <MeetingDetailView detail={detail} command={command} busy={busy} target={target} /> :
      library && (!library.meetings.length ? <section className="panel empty-state"><Icon name="library" />
        <h2>No saved meetings yet</h2><p>Start a local session to save its transcript and audio here.</p></section> :
        <div className="saved-meeting-list">{library.meetings.map(meeting => <article className="panel current-meeting" key={meeting.id}>
          <span className="icon-tile"><Icon name="transcript" /></span>
          <div><h2>{meeting.title}</h2><p>{date(meeting.startedAt)} · {timestamp(meeting.duration)}</p>
            <p className="muted">Recording {meeting.recordingStatus} · Notes {meeting.notesStatus} · {meeting.actionItemCount} actions</p></div>
          <button onClick={() => { setTarget(null); setSelected(meeting.id); setDetail(null) }}>Open meeting</button>
        </article>)}</div>)}
  </div>
}
