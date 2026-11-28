import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { open } from 'node:fs/promises'
import { inside } from '../managed-files'
import type { MeetingStore } from '../db/repository'
import { meetingMarkdown,exportFilename } from './markdown'
import { meetingPdf } from './pdf'
export async function exportMeeting(window:BrowserWindow,store:MeetingStore,id:string,format:'markdown'|'pdf') {
 const detail=store.get(id)
 const extension=format==='pdf'?'pdf':'md'
 const result=await dialog.showSaveDialog(window,{title:'Export meeting',defaultPath:exportFilename(detail.meeting.title)+'.'+extension,
   filters:[{name:format==='pdf'?'PDF document':'Markdown document',extensions:[extension]}]})
 if(result.canceled||!result.filePath)return {cancelled:true}
 if(inside(store.userData,result.filePath))throw new Error('Choose an export location outside Vinxa’s managed application storage.')
 const data=format==='pdf'?await meetingPdf(detail):Buffer.from(meetingMarkdown(detail),'utf8')
 const file=await open(result.filePath,'w')
 try {await file.writeFile(data);await file.sync()} finally {await file.close()}
 return {cancelled:false,path:result.filePath}
}
