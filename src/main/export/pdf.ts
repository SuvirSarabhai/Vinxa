import { BrowserWindow } from 'electron'
import template from './template.html?raw'
import { meetingDetailSchema } from '../../shared/meetings'
import type { MeetingDetail } from '../../shared/meetings'
import { elapsed } from './markdown'
export function escapeHtml(text:string):string {return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}
export function meetingHtml(input:MeetingDetail):string {
 const d=meetingDetailSchema.parse(input),m=d.meeting,e=escapeHtml
 const content='<h1>'+e(m.title)+'</h1><p>Start: '+e(new Date(m.startedAt).toISOString())+
 '</p><p>End: '+(m.endedAt===null?'Not available':e(new Date(m.endedAt).toISOString()))+'</p><p>Duration: '+elapsed(m.duration)+
 '</p><p>Recording: '+m.recordingStatus+' · Notes: '+m.notesStatus+'</p>'+
 (m.error?'<p>Warning: '+e(m.error)+'</p>':'')+
 '<section><h2>Summary</h2><p>'+e(d.insights?.summary??'Notes are not available.')+'</p></section>'+
 '<section><h2>Decisions</h2><ul>'+(d.insights?.decisions.map(x=>'<li>['+elapsed(x.atMs)+'] '+e(x.text)+'</li>').join('')||'<li>No saved decisions.</li>')+'</ul></section>'+
 '<section><h2>Actions</h2><ul>'+(d.actions.map(x=>'<li>['+(x.status==='done'?'x':' ')+'] '+e(x.task)+' — '+e(x.owner??'Unassigned')+' — '+e(x.due??'Unspecified')+'</li>').join('')||'<li>No saved actions.</li>')+'</ul></section>'+
 '<section class="transcript"><h2>Transcript</h2>'+([...d.transcript].sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs||a.id.localeCompare(b.id)).map(s=>'<p><time>['+elapsed(s.startMs)+']</time> <strong>'+e(d.speakers[s.source])+':</strong> '+e(s.text)+'</p>').join('')||'<p>No finalized transcript.</p>')+'</section>'
 return template.replace('{{CONTENT}}',content)
}
export async function meetingPdf(detail:MeetingDetail):Promise<Buffer> {
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false}})
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
 try {
   await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(meetingHtml(detail)))
   return await window.webContents.printToPDF({printBackground:true,pageSize:'A4',margins:{top:0.6,bottom:0.6,left:0.6,right:0.6}})
 } finally {window.destroy()}
}
