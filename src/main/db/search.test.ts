import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MeetingStore } from './repository'
import { searchMeetings } from './search'
it('searches persisted categories, accents and prefixes with safe highlighted snippets and synchronized mutations', () => {
 const dir=mkdtempSync(join(tmpdir(),'vinxa-search-')), store=new MeetingStore(dir), id=randomUUID()
 try {
 store.create(id,{title:'Review',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},100)
 store.saveFinal({id:'segment',meetingId:id,source:'mic',speakerId:null,text:'Café planning',startMs:5000,endMs:6000,isFinal:true})
 store.recording(id,'completed',10000)
 store.replaceInsights(id,{summary:'Café planning summary',decisions:[{text:'Café planning decision',atMs:5000}],actionItems:[{task:'Café planning task',owner:null,due:null,status:'pending'}]},'mock','mock',{summary:'segment',actions:['segment'],decisions:['segment']})
 const results=searchMeetings(store,'cafe plan*')
 expect(results).toHaveLength(4)
 expect(new Set(results.map(r=>r.category)).size).toBe(4)
 expect(results.find(r=>r.category==='Transcript')).toMatchObject({targetId:'segment',speaker:'You',atMs:5000})
 expect(results.every(r=>r.segmentId==='segment' && r.speaker==='You' && r.atMs===5000)).toBe(true)
 expect(results.every(r=>r.snippet.includes('\x01'))).toBe(true)
 expect(searchMeetings(store,'" OR () *')).toEqual([])
 expect(searchMeetings(store,'')).toEqual([])
 store.replaceInsights(id,{summary:'Replaced',decisions:[],actionItems:[]},'mock','mock')
 expect(searchMeetings(store,'cafe')).toHaveLength(1)
 store.db.prepare('DELETE FROM meetings WHERE id=?').run(id)
 expect(searchMeetings(store,'cafe')).toEqual([])
 } finally {store.close();rmSync(dir,{recursive:true,force:true})}
})
