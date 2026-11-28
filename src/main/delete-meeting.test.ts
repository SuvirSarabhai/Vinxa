import {it,expect} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {MeetingStore} from './db/repository'
import {deleteMeeting,deletionPending} from './delete-meeting'
import {searchMeetings} from './db/search'
it('retains a retry record after partial failure, then removes DB, FTS and managed files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'vinxa-delete-')),store=new MeetingStore(root),id=randomUUID()
 try{
 store.create(id,{title:'Delete fixture',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},1000)
 store.saveFinal({id:randomUUID(),meetingId:id,source:'mic',speakerId:'you',text:'unique deletion token',startMs:0,endMs:1000,isFinal:true})
 await expect(deleteMeeting(store,id)).rejects.toThrow('Wait')
 store.recording(id,'completed',2000)
 const dir=join(root,'meetings',id);mkdirSync(dir,{recursive:true});const wav=join(dir,'microphone.wav')
 const log=join(root,'consent-events.jsonl'), other=JSON.stringify({sessionId:randomUUID()})+'\n'
 writeFileSync(log,JSON.stringify({sessionId:id})+'\n'+other)
 writeFileSync(wav,'audio');writeFileSync(join(dir,'metadata.json'),'{}');store.audio(id,{microphoneAudioPath:wav,systemAudioPath:null})
 await expect(deleteMeeting(store,id,async()=>{throw new Error('EACCES')})).rejects.toThrow('incomplete')
 expect(deletionPending(store,id)).toBe(true);expect(store.meeting(id).notesMessage).toContain('incomplete')
 expect(searchMeetings(store,'unique')).toEqual([])
 expect(store.db.prepare("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'unique'").all()).toEqual([])
 await deleteMeeting(store,id)
 expect(readFileSync(log,'utf8')).toBe(other)
 expect(existsSync(dir)).toBe(false);expect(store.list().meetings).toHaveLength(0)
 expect(store.db.prepare('SELECT * FROM deletion_jobs').all()).toEqual([])
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
it('rejects external paths before deleting any records; tolerates missing files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'vinxa-path-')),store=new MeetingStore(root),id=randomUUID()
 try{
 store.create(id,{title:'Path',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},0);store.recording(id,'completed',100)
 store.audio(id,{microphoneAudioPath:join(root,'outside.wav'),systemAudioPath:null})
 await expect(deleteMeeting(store,id)).rejects.toThrow('Unsafe')
 expect(deletionPending(store,id)).toBe(false)
 store.audio(id,{microphoneAudioPath:join(root,'meetings',id,'microphone.wav'),systemAudioPath:null})
 await deleteMeeting(store,id);expect(store.list().meetings).toEqual([])
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
