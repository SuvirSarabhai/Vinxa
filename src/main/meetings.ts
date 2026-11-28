import { ipcMain, safeStorage, dialog } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import { meetingCommandSchema, meetingIdSchema } from '../shared/meetings'
import type { RecordingBackend } from '../shared/phase2'
import type { MeetingStore } from './db/repository'
import { NotesSettingsStore } from './insights/settings'
import { MeetingNotesService } from './insights/meeting-notes'
import { withMeetingPersistence } from './persistent-recording-backend'
import { searchMeetings } from './db/search'
import { searchQuerySchema, exportRequestSchema } from '../shared/phase4'
import { exportMeeting } from './export/save'
import { deleteMeeting, deletionPending, assertMeetingIdle } from './delete-meeting'
import { networkGuard } from './network-guard'
import { NotesQueue } from './insights/queue'
import { markInterrupted,recoverMeeting } from './recovery'
import { installedSpeechModel } from './sidecar-manager'
import { settingsUpdateSchema } from '../shared/meetings'
import { DiskSpace } from './disk-space'
import { OllamaNotesProvider } from './insights/ollama'
import { OpenAINotesProvider } from './insights/openai'

export function installMeetings(window: BrowserWindow, recording: RecordingBackend, store: MeetingStore, onDeleted: (id: string) => void) {
  markInterrupted(store)
  const settings = new NotesSettingsStore(store, safeStorage)
  networkGuard.configure(()=>{const value=settings.get();return value.provider==='openai'&&value.cloudEnabled},store)
  let queued: ReturnType<typeof setImmediate> | undefined
  let disposed = false
  const changed = (): void => {
    if (queued || disposed) return
    queued = setImmediate(() => {
      queued = undefined
      if (!disposed && !window.isDestroyed()) window.webContents.send(ipcChannels.meetingsChanged)
    })
  }
  const notes = new MeetingNotesService(store, settings, changed)
  const disk=new DiskSpace(store.userData,changed)
  const operations=new Set<string>()
  const pendingOperations=new Set<Promise<unknown>>()
  const persisted=withMeetingPersistence(recording, store, notes, changed)
  const backend = disk.wrap({...persisted,start:async(...args)=>{
    if(operations.size||notes.isRunning())throw new Error('Wait for the current notes or meeting operation to finish before recording.')
    await persisted.start(...args)
  }})
  const queue=new NotesQueue(store,notes,changed,()=>!operations.size&&!disposed)
  queue.start()
  void disk.check(2)
  async function exclusive<T>(id:string,operation:()=>Promise<T>,allowNotes=false):Promise<T>{
    if(operations.size||(!allowNotes&&notes.isRunning()))throw new Error('Another meeting operation is in progress.')
    operations.add(id)
    const work=Promise.resolve().then(operation)
    pendingOperations.add(work)
    try{return await work}finally{operations.delete(id);pendingOperations.delete(work)}
  }
  function trusted(event: IpcMainInvokeEvent): void {
    if (disposed || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted meeting request.')
  }
  const channels: string[] = []
  function handle(channel: string, operation: (input: unknown) => unknown): void {
    channels.push(channel)
    ipcMain.handle(channel, (event, payload: unknown) => { trusted(event); return operation(payload) })
  }
  handle(ipcChannels.meetingsList, () => store.list())
  handle(ipcChannels.meetingsRecover,input=>{
    const id=meetingIdSchema.parse(input)
    return exclusive(id,async()=>{await recoverMeeting(store,id);changed()}).then(() => {
      void queue.tick().catch(() => undefined)
    })
  })
  handle(ipcChannels.notesRetryPending,()=>{queue.retry()})
  handle(ipcChannels.privacyStatus,async()=>{
    const value=settings.get(),cloud=value.provider==='openai'&&value.cloudEnabled
    const provider=value.provider==='ollama'?new OllamaNotesProvider(value.ollamaModel,5000):new OpenAINotesProvider(value.openaiModel,()=>settings.key(),()=>cloud,5000)
    const availability=await provider.available().catch(()=>({available:false,message:'Notes provider configuration is unavailable.'}))
    return {localOnly:!cloud,provider:value.provider,...networkGuard.status(),
      pendingNotes:(store.db.prepare("SELECT COUNT(*) AS count FROM meetings WHERE notesStatus IN ('pending','processing') AND id NOT IN (SELECT meetingId FROM deletion_jobs)").get() as {count:number}).count,
      providerMessage:availability.message??(availability.available?'Notes provider is ready.':'Notes provider is unavailable.'),storageWarning:disk.warning,storageLocation:disk.location}
  })
  handle(ipcChannels.meetingsSearch, input => searchMeetings(store, searchQuerySchema.parse(input)))
  handle(ipcChannels.meetingsExport, input => {
    const value=exportRequestSchema.parse(input)
    if(deletionPending(store,value.id))throw new Error('Finish deleting this meeting before another operation.')
    return exclusive(value.id,()=>exportMeeting(window,store,value.id,value.format),true)
  })
  handle(ipcChannels.meetingsDelete, input => {
    const id=meetingIdSchema.parse(input)
    return exclusive(id,async()=>{
      assertMeetingIdle(store,id)
      const response=await dialog.showMessageBox(window,{type:'warning',title:'Permanently delete meeting?',
        message:'Delete '+store.meeting(id).title+'?',detail:'This removes the saved transcript, summary, decisions, actions, speaker names, the consent receipt, search entries, microphone and system WAV files, metadata and derived files in this meeting’s managed folder. Exported copies outside that folder and transcript text previously sent to a cloud notes provider remain. This cannot be undone. File overwriting cannot guarantee secure erasure on SSDs or synced storage.',
        buttons:['Cancel','Permanently delete'],defaultId:0,cancelId:0,noLink:true})
      if(response.response!==1)return {cancelled:true}
      await deleteMeeting(store,id);onDeleted(id);changed();return {cancelled:false}
    })
  })
  handle(ipcChannels.meetingsGet, input => store.get(meetingIdSchema.parse(input)))
  handle(ipcChannels.settingsGet, () => settings.get())
  handle(ipcChannels.settingsSet, input => {
    const update = settingsUpdateSchema.parse(input)
    if (update.speechModel !== 'default' && !installedSpeechModel(process.resourcesPath, update.speechModel)) {
      throw new Error('This speech model is missing from the local cache. Install it or select the startup default.')
    }
    const value = settings.save(update)
    queue.retry()
    changed()
    return value
  })
  const commands = { rename: ipcChannels.meetingsRename, speaker: ipcChannels.speakerRename,
    action: ipcChannels.actionUpdate, notes: ipcChannels.notesGenerate } as const
  for (const [kind, channel] of Object.entries(commands)) {
    handle(channel, async input => {
      const command = meetingCommandSchema.parse(input)
      if (command.type !== kind) throw new Error('Meeting command does not match its channel.')
      if(operations.size||deletionPending(store,command.id))throw new Error('Another operation or deletion is pending for this meeting.')
      if (command.type === 'rename') store.rename(command.id, command.title)
      else if (command.type === 'speaker') store.renameSpeaker(command.id, command.source, command.name)
      else if (command.type === 'action') store.actionStatus(command.id, command.actionId, command.status)
      else void notes.generate(command.id).catch(() => {
        store.notesStatus(command.id, 'failed', 'Notes could not be saved. Retry generation.'); changed()
      })
      changed()
      return store.get(command.id)
    })
  }
  return {
    backend,
    changed,
    exclusive,
    async close() {
      disposed = true
      disk.close()
      if (queued) clearImmediate(queued)
      channels.forEach(channel => ipcMain.removeHandler(channel))
      try { await queue.close();await notes.drain();await Promise.allSettled(pendingOperations) } finally { networkGuard.detach();store.close() }
    }
  }
}
