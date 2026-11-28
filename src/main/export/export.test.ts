import {describe,it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {MeetingStore} from '../db/repository'
import {meetingMarkdown} from './markdown'
import {meetingHtml} from './pdf'
describe('persisted exports',()=>{it('escapes markup, preserves Hindi, timestamps, missing data and completed tasks',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vinxa-export-'));const store=new MeetingStore(dir);const id=randomUUID()
 try {
 store.create(id,{title:'Hindi <script> & *meeting*',microphoneEnabled:true,systemAudioEnabled:false,microphoneDeviceId:null},1000)
 store.saveFinal({id:randomUUID(),meetingId:id,source:'mic',speakerId:'you',text:'नमस्ते <img src=x> & plan',startMs:5000,endMs:6000,isFinal:true})
 store.recording(id,'completed',8000)
 const detail=store.get(id),md=meetingMarkdown(detail),html=meetingHtml(detail)
 expect(md).toContain('नमस्ते');expect(md).toContain('[00:00:05]');expect(md).toContain('Notes are not available')
 expect(html).toContain('&lt;script&gt;');expect(html).toContain('&lt;img src=x&gt;');expect(html).not.toContain('<img src=x>')
 store.replaceInsights(id,{summary:'सारांश',decisions:[{text:'Ship',atMs:5000}],actionItems:[{task:'Send plan',owner:null,due:null,status:'done'}]},'ollama','test')
 expect(meetingMarkdown(store.get(id))).toContain('- [x] Send plan')
 expect(meetingMarkdown(store.get(id))).toContain('Unassigned')
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})})
