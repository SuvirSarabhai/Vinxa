import {statfs} from 'node:fs/promises'
import {join} from 'node:path'
import type {RecordingBackend} from '../shared/phase2'
import {pcmFormat} from '../shared/pcm'
export class DiskSpace {
 warning=''
 readonly location:string
 private timer?:ReturnType<typeof setInterval>
 constructor(private readonly userData:string,private readonly changed:()=>void,
  private readonly inspect:typeof statfs=statfs){this.location=join(userData,'meetings')}
 async check(sources:number):Promise<string>{
  try{
   const space=await this.inspect(this.userData)
   const perHour=pcmFormat.sampleRate*1*2*3600*Math.max(1,sources)
   const reserve=128*1024*1024+perHour/6
   this.warning=Number(space.bavail)*Number(space.bsize)<reserve?
    'Low storage at '+this.location+'. Recording needs about '+Math.ceil(perHour/1000000)+' MB per hour for these sources. Free space before continuing.':''
  }catch{this.warning='Available disk space could not be checked at '+this.location+'. Check free space before a long recording.'}
  this.changed();return this.warning
 }
 wrap(backend:RecordingBackend):RecordingBackend{
  return {...backend,start:async(config,id,events,epoch)=>{
   const sources=Number(config.microphoneEnabled)+Number(config.systemAudioEnabled)
   await this.check(sources)
   await backend.start(config,id,events,epoch)
   if(this.warning)events.notice(this.warning)
   clearInterval(this.timer)
   this.timer=setInterval(()=>{void this.check(sources).then(warning=>{if(warning)events.notice(warning)})},30000);this.timer.unref()
  },stop:async()=>{try{await backend.stop()}finally{clearInterval(this.timer)}},
  dispose:()=>{clearInterval(this.timer);backend.dispose?.()}}
 }
 close():void{clearInterval(this.timer)}
}
