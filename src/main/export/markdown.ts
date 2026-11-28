import type { MeetingDetail } from '../../shared/meetings'
import { meetingDetailSchema } from '../../shared/meetings'
import { transcriptSpeaker } from '../../shared/speaker-label'
export function elapsed(ms:number):string {
 const seconds=Math.floor(ms/1000)
 return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':')
}
export function escapeMarkdown(value:string):string {
 return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g,'\\$&').replace(/\r?\n/g,'  \n')
}
export function meetingMarkdown(input:MeetingDetail):string {
 const d=meetingDetailSchema.parse(input), m=d.meeting, e=escapeMarkdown
 return [
 '# '+e(m.title),'',
 'Start: '+new Date(m.startedAt).toISOString(),
 'End: '+(m.endedAt===null?'Not available':new Date(m.endedAt).toISOString()),
 'Duration: '+elapsed(m.duration),
 'Recording: '+m.recordingStatus+' · Notes: '+m.notesStatus,
 ...(m.error?['Warning: '+e(m.error)]:[]),'',
 '## Summary','',d.insights?e(d.insights.summary):'Notes are not available.','',
 '## Decisions','',...(d.insights?.decisions.length?d.insights.decisions.map(x=>'- ['+elapsed(x.atMs)+'] '+e(x.text)):['No saved decisions.']),'',
 '## Actions','',...(d.actions.length?d.actions.map(x=>'- ['+(x.status==='done'?'x':' ')+'] '+e(x.task)+' — '+e(x.owner??'Unassigned')+' — '+e(x.due??'Unspecified')):['No saved actions.']),'',
 ...((d.bookmarks?.length ?? 0) ? ['## Bookmarks','',...d.bookmarks!.map(b=>'- ['+elapsed(b.atMs)+'] '+e(b.note)),''] : []),
 '## Transcript','',...(d.transcript.length?[...d.transcript].sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs||a.id.localeCompare(b.id)).map(s=>'['+elapsed(s.startMs)+'] '+e(transcriptSpeaker(s,d.speakers))+': '+e(s.text)):['No finalized transcript.']),''
 ].join('\n')
}
export function exportFilename(title:string):string {
 return title.replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/[. ]+$/g,'').trim().slice(0,100)||'Meeting'
}
