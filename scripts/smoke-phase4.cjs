require('./register-typescript.cjs')
const assert=require('node:assert/strict')
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync}=require('node:fs')
const {realpathSync}=require('node:fs')
const {tmpdir}=require('node:os')
const {join,resolve}=require('node:path')
const {randomUUID}=require('node:crypto')
const {_electron}=require('playwright-core')
const {MeetingStore}=require('../src/main/db/repository.ts')
const {MeetingAudioSpool}=require('../src/main/audio/spool.ts')
async function main(){
 const packaged=process.argv.includes('--packaged')
 const profile=mkdtempSync(join(tmpdir(),'vinxa-phase4-ui-')),artifacts=resolve(packaged?'release/phase4-packaged':'release/phase4-ui')
 mkdirSync(artifacts,{recursive:true})
 const id=randomUUID(),crash=randomUUID(),store=new MeetingStore(profile),checks=[],errors=[]
 const config={title:'Phase 4 café नमस्ते fixture',microphoneEnabled:true,systemAudioEnabled:true,microphoneDeviceId:null}
 store.create(id,config,100000)
 for(let i=0;i<220;i++)store.saveFinal({id:'segment-'+i,meetingId:id,source:i%2?'mic':'system',speakerId:null,text:(i===190?'Navigationneedle ':'')+'Paragraph '+i+': नमस्ते टीम। We will review the release plan, verify the exports, and send the agreed report. <script>escaped text</script>',startMs:i*5000,endMs:i*5000+4000,isFinal:true})
 const spool=await MeetingAudioSpool.create(profile,id,config)
 for(const source of ['mic','system'])await spool.append(source,new Uint8Array(3200),{startSample:0})
 store.audio(id,await spool.finalize());store.recording(id,'completed',1200000)
 store.replaceInsights(id,{summary:'Café summary नमस्ते',decisions:[{text:'Approve café release',atMs:950000}],actionItems:[{task:'Send café report',owner:'Navya',due:'Friday',status:'pending'}]},'fixture','mock',{summary:'segment-190',decisions:['segment-190'],actions:['segment-190']})
 store.create(crash,{...config,title:'Interrupted fixture'},200000);store.recording(crash,'paused')
 store.saveFinal({id:'committed',meetingId:crash,source:'mic',speakerId:'you',text:'Committed recovery sentence.',startMs:0,endMs:3000,isFinal:true})
 store.close()
 writeFileSync(join(profile,'phase2-hotkeys.json'),JSON.stringify({start:'Ctrl+Alt+7',pause:'Ctrl+Alt+8',stop:'Ctrl+Alt+9'}))
 const env={...process.env,VINXA_BACKEND:'local',VINXA_SMOKE_USER_DATA:profile,HF_HUB_OFFLINE:'1'}
 for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','VINXA_CAPTURE_TEST'])delete env[key]
 let desktop
 if(packaged)delete env.VINXA_SIDECAR_SOURCE
 const report={packaged,passed:false,profile,checks,errors,notes:'Real SQLite and Electron; synthetic persisted fixture; native dialogs replaced only in this test; no hardware/offline acceptance claim.'}
 try{
 desktop=await _electron.launch({executablePath:packaged?resolve('release/win-unpacked/Vinxa Desktop.exe'):require('electron'),args:packaged?['--user-data-dir='+profile]:[resolve('.')],env,timeout:30000})
 assert.equal(realpathSync.native(await desktop.evaluate(({app})=>app.getPath('userData'))),realpathSync.native(profile))
 const page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message))
 await page.getByRole('button',{name:'Library',exact:true}).click()
 await page.getByRole('searchbox',{name:'Search saved meetings'}).fill('navigationneedle')
 await page.locator('.search-results button').click()
 await page.getByRole('tab',{name:'Transcript',exact:true}).waitFor()
 await page.waitForFunction(()=>document.querySelector('#passage-segment-190')?.classList.contains('search-match'))
 await page.waitForFunction(()=>{const node=document.querySelector('#passage-segment-190'),parent=document.querySelector('.saved-transcript');if(!node||!parent)return false;const a=node.getBoundingClientRect(),b=parent.getBoundingClientRect();return a.top>=Math.max(0,b.top)&&a.bottom<=Math.min(innerHeight,b.bottom)})
 assert.equal(await page.getByRole('tab',{name:'Transcript',exact:true}).getAttribute('aria-selected'),'true')
 const bounds=await page.locator('#passage-segment-190').boundingBox();assert.ok(bounds)
 await page.screenshot({path:join(artifacts,'search-location.png'),fullPage:true})
 checks.push('Search click opens and highlights original transcript segment at 15:50')
 await page.getByRole('button',{name:'Back to library',exact:true}).click()
 await page.getByRole('searchbox',{name:'Search saved meetings'}).fill('cafe')
 await page.waitForFunction(()=>document.querySelectorAll('.search-results button').length===3)
 assert.equal(await page.locator('.search-results mark').count(),3)
 checks.push('Accent and prefix search includes summary, decision, action')
 await page.locator('.search-results button').filter({hasText:'Summary'}).click()
 await page.waitForFunction(()=>document.querySelector('#passage-segment-190')?.classList.contains('search-match'))
 assert.equal(await page.getByRole('tab',{name:'Transcript',exact:true}).getAttribute('aria-selected'),'true')
 checks.push('Summary result opens its cited speaker and transcript passage')
 const md=join(artifacts,'meeting.md'),pdf=join(artifacts,'meeting.pdf')
 for(const [format,path] of [['Markdown',md],['PDF',pdf]]){
  await desktop.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path})},path)
  await page.getByRole('button',{name:'Export '+format,exact:true}).click()
  await page.getByText('Export saved: '+path,{exact:true}).waitFor({timeout:30000})
 }
 assert.match(readFileSync(md,'utf8'),/नमस्ते/);assert.match(readFileSync(md,'utf8'),/Navigationneedle/)
 assert.match(readFileSync(pdf).subarray(0,8).toString(),/^%PDF-/)
 checks.push('Real Markdown save and Electron printToPDF save')
 const before=await page.evaluate(()=>window.vinxaMeetings.status())
 const blocked=await desktop.evaluate(async({session})=>{
  const results=[]
  for(const url of ['http://example.test/phase4','https://example.test/phase4']){
   try{await session.defaultSession.fetch(url);results.push(false)}catch{results.push(true)}
  }
  return results
 })
 assert.deepEqual(blocked,[true,true])
 const after=await page.evaluate(()=>window.vinxaMeetings.status())
 assert.equal(after.blocked,before.blocked+2);assert.equal(after.allowedCloud,0);assert.equal(after.localOnly,true)
 checks.push('Real Electron interception blocks HTTP and HTTPS and increments persistent counter')
 await desktop.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false})})
 await page.getByRole('button',{name:'Delete meeting',exact:true}).click()
 assert.equal((await page.evaluate(id=>window.vinxaMeetings.get(id),id)).transcript.length,220)
 await desktop.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false})})
 await page.getByRole('button',{name:'Delete meeting',exact:true}).click()
 await page.getByText('Meeting permanently deleted.',{exact:true}).waitFor()
 assert.equal(existsSync(join(profile,'meetings',id)),false)
 assert.deepEqual(await page.evaluate(()=>window.vinxaMeetings.search('cafe')),[])
 checks.push('Cancel preserves data; confirmed delete removes managed files, DB and search')
 await page.getByRole('button',{name:'Open meeting',exact:true}).click()
 await page.getByText('Recording interrupted · Notes pending',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Recover meeting',exact:true}).click()
 await page.getByText(/Committed meeting data recovered/).waitFor()
 const recovered=await page.evaluate(id=>window.vinxaMeetings.get(id),crash)
 assert.equal(recovered.meeting.recordingStatus,'completed');assert.equal(recovered.transcript.length,1)
 assert.match(recovered.meeting.error,/No audio files/)
 checks.push('Interrupted meeting recovery UI preserves committed text and missing-audio warning')
 await page.getByRole('button',{name:'Settings',exact:true}).click()
 await page.getByRole('heading',{name:'Privacy and service status'}).waitFor()
 await page.getByText('Blocked external requests: '+after.blocked+' · Allowed cloud requests: 0',{exact:true}).waitFor()
 await page.screenshot({path:join(artifacts,'privacy-settings.png'),fullPage:true})
 const modelSelect=page.getByLabel('Speech model size')
 await modelSelect.selectOption('base.en')
 await page.getByRole('button',{name:'Save notes settings'}).click()
 await page.getByText('Notes settings saved.').waitFor()
 assert.equal((await page.evaluate(()=>window.vinxaMeetings.settings())).speechModel,'base.en')
 assert.deepEqual(errors,[])
 await desktop.close();desktop=undefined
 const saved=new MeetingStore(profile)
 try{
 assert.equal(JSON.parse(saved.setting('notes')).speechModel,'base.en')
 assert.equal(saved.list().meetings.length,1)
 assert.equal(JSON.parse(saved.setting('network-counts')).blocked,after.blocked)
 assert.equal(saved.db.prepare('SELECT COUNT(*) AS n FROM transcript_segments WHERE meetingId=?').get(id).n,0)
 assert.equal(saved.db.prepare('SELECT COUNT(*) AS n FROM notes_fts WHERE meetingId=?').get(id).n,0)
 }finally{saved.close()}
 checks.push('Persistence and deletion residue checked after Electron shutdown')
 report.passed=true;console.log(JSON.stringify(report,null,2))
 }catch(error){report.failure=String(error);throw error}
 finally{await desktop?.close();writeFileSync(join(artifacts,'report.json'),JSON.stringify(report,null,2))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
