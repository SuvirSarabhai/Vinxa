import {open,unlink,rmdir} from 'node:fs/promises'
import type {MeetingStore} from './db/repository'
import { removeConsent } from './consent-log'
import {managedFiles} from './managed-files'
export function deletionPending(store:MeetingStore,id:string):boolean{return Boolean(store.db.prepare('SELECT 1 FROM deletion_jobs WHERE meetingId=?').get(id))}
export function assertMeetingIdle(store:MeetingStore,id:string):void {
 const meeting=store.meeting(id)
 if(['recording','paused','stopping','processing'].includes(meeting.recordingStatus)||meeting.notesStatus==='processing')throw new Error('Wait for recording and notes to finish before this operation.')
}
export async function eraseFile(path:string):Promise<void>{
 let file;try{file=await open(path,'r+')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 try{
  const size=(await file.stat()).size,zeros=Buffer.alloc(1024*1024)
  for(let offset=0;offset<size;){const count=Math.min(zeros.length,size-offset);const result=await file.write(zeros,0,count,offset);if(!result.bytesWritten)throw new Error('File overwrite failed.');offset+=result.bytesWritten}
  await file.sync()
 }finally{await file.close()}
 await unlink(path)
}
export async function deleteMeeting(store:MeetingStore,id:string,erase=eraseFile):Promise<void>{
 assertMeetingIdle(store,id)
 if(store.db.prepare("SELECT 1 FROM meetings WHERE recordingStatus IN ('recording','paused','stopping','processing') OR notesStatus='processing'").get())throw new Error('Finish other recording or notes jobs before deleting.')
 const meeting=store.meeting(id)
 const paths=await managedFiles(store.userData,id,[meeting.microphoneAudioPath,meeting.systemAudioPath])
 store.db.transaction(()=>{
  store.db.prepare("INSERT INTO deletion_jobs VALUES (?,'files',NULL) ON CONFLICT(meetingId) DO UPDATE SET error=NULL").run(id)
  for(const table of ['bookmarks','crm_deliveries','transcript_segments','meeting_notes','decisions','action_items','notes_queue'])store.db.prepare('DELETE FROM '+table+' WHERE meetingId=?').run(id)
  store.notesStatus(id,'failed','Deletion in progress. If interrupted, use Delete meeting again to finish.')
 })()
 try{
  await removeConsent(store.userData, id)
  for(const path of paths.files)await erase(path)
  for(const path of paths.directories)await rmdir(path)
  const residue=await managedFiles(store.userData,id)
  if(residue.files.length||residue.directories.length)throw new Error('Meeting files remain.')
  const checkpoint=()=>{const rows=store.db.pragma('wal_checkpoint(TRUNCATE)') as {busy:number}[];if(rows.some(row=>row.busy))throw new Error('Database checkpoint is busy.')}
  checkpoint()
  store.db.exec('VACUUM')
  for(const table of ['bookmarks','crm_deliveries','remote_speakers','transcript_segments','meeting_notes','decisions','action_items','notes_fts','note_sources'])
   if(store.db.prepare('SELECT 1 FROM '+table+' WHERE meetingId=?').get(id))throw new Error('Meeting records remain.')
  store.db.prepare('DELETE FROM meetings WHERE id=?').run(id)
  checkpoint()
  store.db.exec('VACUUM')
  checkpoint()
  if(store.db.prepare('SELECT 1 FROM meetings WHERE id=?').get(id))throw new Error('Meeting record remains.')
 }catch{
  if(!store.db.prepare('SELECT 1 FROM meetings WHERE id=?').get(id)){
   const {actionItemCount:_actions,pendingActionCount:_pending,...row}=meeting
   const columns=Object.keys(row)
   store.db.prepare('INSERT INTO meetings('+columns.join(',')+') VALUES ('+columns.map(column=>'@'+column).join(',')+')').run(row)
   store.db.prepare("INSERT INTO deletion_jobs VALUES (?,'files',NULL)").run(id)
  }
  store.db.prepare("UPDATE deletion_jobs SET error='Cleanup failed. Retry Delete meeting.' WHERE meetingId=?").run(id)
  store.notesStatus(id,'failed','Deletion incomplete. Some data may already be removed. Retry Delete meeting to finish.')
  throw new Error('Deletion incomplete. Meeting retained for retry; check file permissions and available disk space.')
 }
}
