import {useEffect,useState} from 'react'
import type {Phase4Status} from '../../../shared/phase4'
import type {Phase2Snapshot} from '../../../shared/phase2'
import type {CommandHandler} from './session'
export function PrivacyStatus({snapshot,command}:{snapshot:Phase2Snapshot;command:CommandHandler}){
 const [status,setStatus]=useState<Phase4Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[device,setDevice]=useState('')
 useEffect(()=>{
  let active=true,pending=false
  const refresh=async()=>{if(pending)return;pending=true;try{const value=await window.vinxaMeetings.status();if(active){setStatus(value);setError('')}}catch{if(active)setError('Privacy and provider status could not be loaded.')}finally{pending=false}}
  void refresh();const timer=setInterval(()=>void refresh(),15000),off=window.vinxaMeetings.onChange(()=>void refresh())
  return()=>{active=false;clearInterval(timer);off()}
 },[])
 useEffect(()=>{
  if(snapshot.state!=='paused')return
  let active=true
  void navigator.mediaDevices.enumerateDevices().then(values=>{if(active)setDevices(values.filter(d=>d.kind==='audioinput'&&!['default','communications'].includes(d.deviceId)))}).catch(()=>{if(active)setError('Microphones could not be listed. Reconnect the original device and retry.')})
  return()=>{active=false}
 },[snapshot.state])
 return <section className="panel notes-settings">
  <h2>Privacy and service status</h2>
  {error&&<p role="alert" className="error">{error}</p>}
  {!status&&!error&&<p role="status">Checking services…</p>}
  {status&&<>
   <p><strong>{status.localOnly?'Local-only':'Cloud notes enabled'}</strong> · Selected provider: {status.provider}</p>
   <p>{status.localOnly?'App requests outside loopback are blocked. Speech and local notes run on this laptop.':'Only transcript text and notes instructions can be sent to OpenAI. Audio stays on this laptop.'}</p>
   <p>Blocked external requests: {status.blocked} · Allowed cloud requests: {status.allowedCloud}</p>
   <p className="field-help">Counters persist across restarts and count request attempts, not successful responses. They exclude local requests and do not monitor other applications.</p>
   <p>{snapshot.engine.message}</p><p>{status.providerMessage}</p>
   <p>Pending or processing notes: {status.pendingNotes}</p>
   <p>Meeting storage: {status.storageLocation}</p>
   {status.storageWarning&&<p className="notice" role="alert">{status.storageWarning}</p>}
   <button disabled={busy} onClick={()=>{setBusy(true);void window.vinxaMeetings.retryPending().catch(()=>setError('Pending notes could not be queued.')).finally(()=>setBusy(false))}}>Retry pending notes</button>
  </>}
  {snapshot.state==='paused'&&snapshot.config.microphoneEnabled&&<div className="field">
   <label>Microphone for this session<select aria-label="Replacement microphone" value={device} onChange={e=>setDevice(e.target.value)}>
    <option value="">Keep the original microphone</option>
    {devices.map((d,index)=><option value={d.deviceId} key={d.deviceId}>{d.label||'Microphone '+(index+1)}</option>)}
   </select></label>
   <button disabled={!device||snapshot.busy} onClick={()=>void command({type:'select-microphone',deviceId:device})}>Use selected microphone</button>
   <p>Resume after selecting. The session and original timestamps are retained.</p>
  </div>}
 </section>
}
