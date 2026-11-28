import {lstat,realpath,readdir} from 'node:fs/promises'
import {resolve,join,relative,isAbsolute} from 'node:path'
import {meetingIdSchema} from '../shared/meetings'
export function inside(root:string,path:string):boolean {
 const rel=relative(resolve(root),resolve(path))
 return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))
}
export async function managedFiles(userData:string,id:string,storedPaths:(string|null)[]=[]) {
 meetingIdSchema.parse(id)
 const root=resolve(userData),base=join(root,'meetings'),directory=join(base,id)
 const canonicalRoot=await realpath(root)
 for(const path of storedPaths)if(path&&!inside(directory,path))throw new Error('Unsafe meeting file path. No files were removed.')
 // Reject links/junctions at every existing component; never follow a redirected parent.
 for(const path of [root,base,directory]){
  try{const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isDirectory()||resolve(await realpath(path)).toLowerCase()!==resolve(canonicalRoot,relative(root,path)).toLowerCase())throw new Error('Unsafe managed directory.')}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 }
 const files:string[]=[],directories:string[]=[]
 async function walk(path:string):Promise<void>{
  let entries;try{entries=await readdir(path,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  for(const entry of entries){
   const child=join(path,entry.name);const stat=await lstat(child)
   if(!inside(directory,child)||stat.isSymbolicLink()||stat.nlink>1||(!stat.isFile()&&!stat.isDirectory()))throw new Error('Unsafe meeting file. No external files were touched.')
   if(stat.isDirectory())await walk(child);else files.push(child)
  }
  directories.push(path)
 }
 await walk(directory)
 return {directory,files,directories}
}
