import type {MeetingStore} from '../db/repository'
import type {MeetingNotesService} from './meeting-notes'
export class NotesQueue {
 private timer?:ReturnType<typeof setInterval>
 private work?:Promise<void>
 private closed=false
 constructor(private readonly store:MeetingStore,private readonly notes:Pick<MeetingNotesService,'generate'|'isRunning'>,
  private readonly changed:()=>void,private readonly canRun=()=>true,private readonly now=Date.now){}
 start():void{
  this.timer=setInterval(()=>void this.tick().catch(()=>undefined),30000);this.timer.unref()
  void this.tick().catch(()=>undefined)
 }
 tick():Promise<void>{
  if(this.work)return this.work
  this.work=this.process().finally(()=>{this.work=undefined})
  return this.work
 }
 retry():void{
  this.store.db.transaction(()=>{
   this.store.db.prepare("DELETE FROM notes_queue WHERE meetingId IN (SELECT id FROM meetings WHERE recordingStatus='completed' AND notesStatus IN ('pending','failed'))").run()
   this.store.db.prepare("UPDATE meetings SET notesStatus='pending',notesMessage='Queued for retry.' WHERE recordingStatus='completed' AND notesStatus IN ('pending','failed') AND id NOT IN (SELECT meetingId FROM deletion_jobs)").run()
  })()
  this.changed();void this.tick().catch(()=>undefined)
 }
 private async process():Promise<void>{
  if(this.closed||!this.canRun()||this.notes.isRunning())return
  if(this.store.db.prepare("SELECT 1 FROM meetings WHERE recordingStatus IN ('recording','paused','stopping','processing')").get())return
  this.store.db.prepare("INSERT OR IGNORE INTO notes_queue(meetingId) SELECT id FROM meetings WHERE recordingStatus='completed' AND notesStatus='pending' AND id NOT IN (SELECT meetingId FROM deletion_jobs)").run()
  const rows=this.store.db.prepare("SELECT q.meetingId,q.attempts FROM notes_queue q JOIN meetings m ON m.id=q.meetingId WHERE m.recordingStatus='completed' AND m.notesStatus='pending' AND q.nextAt<=? AND m.id NOT IN (SELECT meetingId FROM deletion_jobs) ORDER BY q.nextAt,m.startedAt LIMIT 1").all(this.now()) as {meetingId:string;attempts:number}[]
  for(const row of rows){
   if(this.closed||!this.canRun())return
   const attempts=Math.min(row.attempts+1,3)
   this.store.db.prepare('UPDATE notes_queue SET attempts=?,nextAt=? WHERE meetingId=?').run(attempts,this.now()+[30000,120000,600000][attempts-1],row.meetingId)
   try{await this.notes.generate(row.meetingId)}catch{this.store.notesStatus(row.meetingId,'failed','Notes processing failed. Retry from Settings.')}
   const status=this.store.meeting(row.meetingId).notesStatus
   if(status==='completed')this.store.db.prepare('DELETE FROM notes_queue WHERE meetingId=?').run(row.meetingId)
   this.changed()
  }
 }
 async close():Promise<void>{this.closed=true;clearInterval(this.timer);await this.work}
}
