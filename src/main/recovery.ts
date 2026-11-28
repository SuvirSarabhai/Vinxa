import {open,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import type {MeetingStore} from './db/repository'
import {managedFiles} from './managed-files'
import {wavHeader} from './audio/wav-writer'
import {deletionPending} from './delete-meeting'
export function markInterrupted(store:MeetingStore):number{
 return store.db.transaction(()=>{
  const result=store.db.prepare("UPDATE meetings SET recordingStatus='interrupted',error='Vinxa closed before recording finished. Recover this meeting to inspect committed transcript and audio.',notesStatus='pending',notesMessage='Recovery required before notes generation.' WHERE recordingStatus IN ('recording','paused','stopping')").run()
  store.db.prepare("UPDATE meetings SET recordingStatus='completed',notesStatus=CASE WHEN notesStatus='processing' THEN 'pending' ELSE notesStatus END,notesMessage='Recording saved; notes generation was interrupted and will retry.' WHERE recordingStatus='processing'").run()
  store.db.prepare("UPDATE meetings SET notesStatus='pending',notesMessage='Notes generation was interrupted and will retry.' WHERE recordingStatus='completed' AND notesStatus='processing'").run()
  return result.changes
 })()
}
export async function recoverMeeting(store:MeetingStore,id:string):Promise<void>{
 const meeting=store.meeting(id)
 if(!['interrupted','error'].includes(meeting.recordingStatus)||deletionPending(store,id))throw new Error('This meeting is not available for recovery.')
 const files=await managedFiles(store.userData,id,[meeting.microphoneAudioPath,meeting.systemAudioPath])
 const warnings=['Recovered committed data after an interruption. Uncommitted words or audio may be missing.']
 const recoveredPaths={microphoneAudioPath:meeting.microphoneAudioPath,systemAudioPath:meeting.systemAudioPath}
 for(const [key,name] of [['microphoneAudioPath','microphone.wav'],['systemAudioPath','system.wav']] as const){
  const candidate=join(files.directory,name)
  if(!recoveredPaths[key]&&files.files.includes(candidate)){recoveredPaths[key]=candidate;warnings.push(name+' was recovered before its database path had been saved.')}
 }
 let duration=Math.max(meeting.duration,...store.transcript(id).map(s=>s.endMs),0)
 const sources:Record<string,unknown>={}
 for(const [source,path] of [['mic',recoveredPaths.microphoneAudioPath],['system',recoveredPaths.systemAudioPath]] as const){
  if(!path)continue
  let file
  try{
   file=await open(path,'r+')
   const stat=await file.stat(),header=Buffer.alloc(44)
   const read=await file.read(header,0,44,0),expected=wavHeader(0)
   if(read.bytesRead!==44||!header.subarray(0,4).equals(expected.subarray(0,4))||!header.subarray(8,40).equals(expected.subarray(8,40))||stat.size-44>0xffffffff-36){
    warnings.push(source+' audio is corrupt or unsupported; its file was preserved.');continue
   }
   const bytes=Math.max(0,stat.size-44),complete=bytes-bytes%2
   if(bytes%2)warnings.push(source+' audio ended with an incomplete sample; the trailing byte was removed.')
   if(!complete)warnings.push(source+' audio is empty.')
   if(header.readUInt32LE(40)!==complete)warnings.push(source+' WAV length was repaired from bytes on disk.')
   await file.truncate(44+complete)
   const repaired=wavHeader(complete)
   for(let offset=0;offset<44;){const result=await file.write(repaired,offset,44-offset,offset);if(!result.bytesWritten)throw new Error('WAV header write failed.');offset+=result.bytesWritten}
   await file.sync()
   duration=Math.max(duration,Math.floor(complete/32))
   sources[source]={file:source==='mic'?'microphone.wav':'system.wav',samples:complete/2,recovered:true}
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')warnings.push(source+' audio file is missing.')
   else throw new Error('Recovery could not read or finalize audio. Check file permissions and retry.')
  }finally{await file?.close()}
 }
 if(!recoveredPaths.microphoneAudioPath&&!recoveredPaths.systemAudioPath)warnings.push('No audio files were registered before interruption.')
 if(!store.transcript(id).length)warnings.push('No finalized transcript was committed; notes cannot be generated.')
 await mkdir(files.directory,{recursive:true})
 await writeFile(join(files.directory,'metadata.json'),JSON.stringify({sampleRate:16000,channels:1,encoding:'pcm_s16le',recovered:true,warnings,sources},null,2))
 store.db.transaction(()=>{
  store.audio(id,recoveredPaths)
  store.recording(id,'completed',meeting.startedAt+duration,warnings.join(' '))
  store.notesStatus(id,store.transcript(id).length?'pending':'failed',store.transcript(id).length?'Recovered transcript is ready for review and notes.':'No finalized transcript is available.')
 })()
}
