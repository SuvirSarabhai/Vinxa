import type {Session} from 'electron'
import type {MeetingStore} from './db/repository'
type Counters={blocked:number;allowedCloud:number}
export function loopback(url:URL):boolean {
 return ['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase())
}
export class NetworkGuard {
 private counters:Counters={blocked:0,allowedCloud:0}
 private policy=()=>false
 private persist?:(counts:Counters)=>void
 configure(cloudEnabled:()=>boolean,store?:MeetingStore):void{
  this.policy=cloudEnabled
  if(store){
   try{const counts=JSON.parse(store.setting('network-counts')??'{}');if(Number.isSafeInteger(counts.blocked)&&counts.blocked>=0&&Number.isSafeInteger(counts.allowedCloud)&&counts.allowedCloud>=0)this.counters=counts}catch{/* Invalid counters start at zero. */}
   this.persist=counts=>store.setSetting('network-counts',JSON.stringify(counts))
  }
 }
 detach():void{this.policy=()=>false;this.persist=undefined}
 status():Counters{return {...this.counters}}
 allow(input:string,notes=false):boolean{
  let url:URL;try{url=new URL(input)}catch{return false}
  if(!['http:','https:','ws:','wss:'].includes(url.protocol))return true
  if(loopback(url)&&!url.username&&!url.password)return true
  const allowed=notes&&this.policy()&&url.origin==='https://api.openai.com'&&url.pathname==='/v1/responses'&&!url.username&&!url.password
  this.counters[allowed?'allowedCloud':'blocked']++
  // Never permit a request if its privacy audit cannot be persisted.
  try{this.persist?.(this.status())}catch{return false}
  return allowed
 }
 install(session:Session):void{
  session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{
   callback({cancel:!this.allow(details.url)})
  })
 }
 async fetch(input:Parameters<typeof fetch>[0],init?:RequestInit):Promise<Response>{
  const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
  if(!this.allow(url,true))throw new Error('External request blocked by Vinxa privacy settings.')
  return fetch(input,{...init,redirect:'error'})
 }
}
export const networkGuard=new NetworkGuard()
export const guardedFetch:typeof fetch=(input,init)=>networkGuard.fetch(input,init)
