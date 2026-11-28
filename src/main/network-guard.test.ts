import {it,expect,vi} from 'vitest'
import {NetworkGuard} from './network-guard'
it('blocks external HTTP/HTTPS/WebSockets; allows loopback; counts without storing URLs',()=>{
 const guard=new NetworkGuard()
 for(const url of ['http://example.test','https://api.openai.com/v1/responses','wss://example.test'])expect(guard.allow(url,true)).toBe(false)
 for(const url of ['http://localhost:5173','http://127.0.0.1:11434/api/chat','ws://127.0.0.1:22345','http://[::1]:11434'])expect(guard.allow(url)).toBe(true)
 expect(guard.status()).toEqual({blocked:3,allowedCloud:0})
 guard.configure(()=>true)
 expect(guard.allow('https://api.openai.com/v1/responses',true)).toBe(true)
 expect(guard.allow('https://api.openai.com/v1/responses')).toBe(false)
 expect(guard.allow('https://api.openai.com.evil.test/v1/responses',true)).toBe(false)
 expect(guard.status()).toEqual({blocked:5,allowedCloud:1})
})
it('does not call fetch in local-only, denies redirects, rechecks consent for every request',async()=>{
 const guard=new NetworkGuard(),fetcher=vi.fn().mockResolvedValue(new Response('{}'))
 vi.stubGlobal('fetch',fetcher)
 try{
 await expect(guard.fetch('https://api.openai.com/v1/responses')).rejects.toThrow('blocked')
 expect(fetcher).not.toHaveBeenCalled()
 guard.configure(()=>true);await guard.fetch('https://api.openai.com/v1/responses')
 expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/responses',{redirect:'error'})
 guard.configure(()=>false);await expect(guard.fetch('https://api.openai.com/v1/responses')).rejects.toThrow('blocked')
 expect(fetcher).toHaveBeenCalledTimes(1)
 }finally{vi.unstubAllGlobals()}
})
