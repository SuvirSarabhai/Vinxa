import {it,expect} from 'vitest'
import {DiskSpace} from './disk-space'
import type {statfs} from 'node:fs/promises'
it('uses actual PCM rate for low-space estimates and handles unavailable disk information',async()=>{
 const low=new DiskSpace('D:/test',()=>{},(async()=>({bavail:1,bsize:4096})) as unknown as typeof statfs)
 expect(await low.check(2)).toContain('231 MB per hour')
 expect(low.warning).toContain('meetings')
 const unavailable=new DiskSpace('D:/test',()=>{},async()=>{throw new Error('Unavailable')})
 expect(await unavailable.check(1)).toContain('could not be checked')
})
