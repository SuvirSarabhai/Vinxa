import {it,expect} from 'vitest'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {MeetingStore} from './db/repository'
import {markInterrupted,recoverMeeting} from './recovery'
import {wavHeader} from './audio/wav-writer'
it('detects recording/paused/stopping, preserves segments and repairs crash WAVs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vinxa-recovery-')),store=new MeetingStore(dir)
 try{for(const status of ['recording','paused','stopping'] as const){
 const id=randomUUID();store.create(id,{title:'Crash fixture',microphoneEnabled:true,systemAudioEnabled:true,microphoneDeviceId:null},1000)
 store.saveFinal({id:randomUUID(),meetingId:id,source:'mic',speakerId:'you',text:'Committed words',startMs:0,endMs:1000,isFinal:true})
 store.recording(id,status)
 const folder=join(dir,'meetings',id);mkdirSync(folder,{recursive:true})
 const mic=join(folder,'microphone.wav'),system=join(folder,'system.wav')
 writeFileSync(mic,Buffer.concat([wavHeader(0),Buffer.alloc(32001)]))
 store.audio(id,{microphoneAudioPath:mic,systemAudioPath:system})
 expect(markInterrupted(store)).toBe(1);expect(store.meeting(id).recordingStatus).toBe('interrupted')
 await recoverMeeting(store,id)
 expect(store.transcript(id)[0].text).toBe('Committed words')
 expect(store.meeting(id).error).toContain('missing')
 expect(store.meeting(id).error).toContain('trailing byte')
 expect(store.meeting(id).recordingStatus).toBe('completed')
 expect(readFileSync(mic).readUInt32LE(40)).toBe(32000)
 }}finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
it('preserves corrupt audio and resets interrupted notes without reclassifying recording as interrupted',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vinxa-corrupt-')),store=new MeetingStore(dir),id=randomUUID()
 try{
 store.create(id,{title:'Corrupt fixture',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},0)
 const folder=join(dir,'meetings',id);mkdirSync(folder,{recursive:true});const path=join(folder,'microphone.wav')
 writeFileSync(path,'corrupt') // Crash happened before the audio paths reached SQLite.
 markInterrupted(store);await recoverMeeting(store,id)
 expect(readFileSync(path,'utf8')).toBe('corrupt');expect(store.meeting(id).error).toContain('corrupt')
 expect(store.meeting(id).microphoneAudioPath).toBe(path)
 expect(store.meeting(id).error).toContain('before its database path')
 expect(store.meeting(id).notesStatus).toBe('failed')
 store.recording(id,'processing');store.notesStatus(id,'processing');markInterrupted(store)
 expect(store.meeting(id).recordingStatus).toBe('completed');expect(store.meeting(id).notesStatus).toBe('pending')
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
