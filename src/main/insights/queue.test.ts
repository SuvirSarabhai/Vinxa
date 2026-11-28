import {it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {MeetingStore} from '../db/repository'
import {NotesQueue} from './queue'
it('persists retry backoff across restarts, prevents duplicate processing, skips interrupted meetings',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vinxa-queue-'));let store=new MeetingStore(dir),now=0,calls=0
 const id=randomUUID(),interrupted=randomUUID()
 const create=(value:string)=>store.create(value,{title:'Queue fixture',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},0)
 create(id);store.recording(id,'completed',1000);create(interrupted);store.recording(interrupted,'interrupted')
 const notes={isRunning:()=>false,generate:async(value:string)=>{calls++;await Promise.resolve();store.notesStatus(value,'pending','Provider unavailable')}}
 let queue=new NotesQueue(store,notes,()=>{},()=>true,()=>now)
 try{
 await Promise.all([queue.tick(),queue.tick()]);expect(calls).toBe(1)
 await queue.tick();expect(calls).toBe(1)
 await queue.close();store.close();store=new MeetingStore(dir);queue=new NotesQueue(store,notes,()=>{},()=>true,()=>now)
 now=30000;await queue.tick();expect(calls).toBe(2)
 now=150000;await queue.tick();expect(calls).toBe(3);expect(store.meeting(id).notesStatus).toBe('pending')
 now=1000000;await queue.tick();expect(calls).toBe(4)
 expect(store.meeting(interrupted).notesStatus).toBe('pending')
 }finally{await queue.close();store.close();rmSync(dir,{recursive:true,force:true})}
})
it('processes pending when the provider returns, re-reading current settings in the notes service',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vinxa-return-')),store=new MeetingStore(dir),id=randomUUID()
 let available=false,now=0
 store.create(id,{title:'Pending',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},0);store.recording(id,'completed',1000)
 const queue=new NotesQueue(store,{isRunning:()=>false,generate:async(value)=>{store.notesStatus(value,available?'completed':'pending')}},()=>{},()=>true,()=>now)
 try{
 await queue.tick();expect(store.meeting(id).notesStatus).toBe('pending')
 now=30000;await queue.tick()
 now=150000;await queue.tick()
 available=true;now=750000;await queue.tick();expect(store.meeting(id).notesStatus).toBe('completed')
 expect(store.db.prepare('SELECT * FROM notes_queue').all()).toEqual([])
 }finally{await queue.close();store.close();rmSync(dir,{recursive:true,force:true})}
})
