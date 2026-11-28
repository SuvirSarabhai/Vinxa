import { dialog, ipcMain, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { phase5Channel, phase5RequestSchema, phase5ResultSchema } from '../../shared/phase5'
import type { Phase5Result } from '../../shared/phase5'
import type { MeetingStore } from '../db/repository'
import type { SessionController } from '../session-controller'
import { addBookmark, askMeetings, bookmarks } from './data'
import { sendMockCrm } from './crm'
import { clusterMeeting } from './clustering'
import { MeetingDetector } from './detection'
import { encryptionStatus, requestEncryption } from './encryption'
import { saveSpeechTuning, speechTuning } from './speech'
import { installedSpeechModel } from '../sidecar-manager'
import { savedNotesSettings } from '../insights/settings'

export function installPhase5(options: {
  store: MeetingStore; controller: SessionController; library: BrowserWindow;
  openLibrary(): void; requestStart(): void; changed(): void;
  exclusive<T>(id: string, operation: () => Promise<T>, allowNotes?: boolean): Promise<T>
}) {
  const { store, controller } = options
  let disposed = false
  const pending = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const detector = new MeetingDetector(() => {
    if (!Notification.isSupported()) return
    const offer = new Notification({ title: 'Possible meeting detected', body: 'A Zoom or Teams window looks like a call. Click to open Vinxa’s consent flow. Recording has not started.' })
    offer.on('click', () => { if (!disposed) options.requestStart() })
    offer.show()
  }, () => !controller.snapshot().busy && ['idle','completed','error'].includes(controller.getState()))
  if (store.setting('meeting-detection') === 'true') detector.start()

  function bookmark(): void {
    const moment = controller.bookmarkMoment()
    addBookmark(store, moment.id, moment.atMs)
    controller.announce('Bookmark saved at ' + Math.floor(moment.atMs / 1000) + ' seconds. Open Tools in the sidebar to revisit it.')
    options.changed()
  }
  async function request(input: unknown): Promise<Phase5Result> {
    const command = phase5RequestSchema.parse(input)
    switch (command.type) {
      case 'overview': return { message: 'Meeting tools are available from the workspace sidebar.',
        meetings: store.list().meetings.map(({ id, title }) => ({ id, title })), detecting: store.setting('meeting-detection') === 'true',
        encryption: await encryptionStatus(store.userData), speech: speechTuning(store.userData) }
      case 'bookmark': bookmark(); return { message: 'Bookmark saved.' }
      case 'detail': return { message: '', bookmarks: bookmarks(store, command.id),
        crm: z.array(z.object({ recordId: z.string(), endpoint: z.string(), status: z.string(), sentAt: z.number().nullable() }))
          .parse(store.db.prepare('SELECT recordId,endpoint,status,sentAt FROM crm_deliveries WHERE meetingId=?').all(command.id)) }
      case 'remove-bookmark':
        store.db.prepare('DELETE FROM bookmarks WHERE id=?').run(command.id); options.changed(); return { message: 'Bookmark removed.' }
      case 'open-passage': {
        const detail = store.get(command.id)
        const ordered = detail.transcript
        const segment = ordered.find(s => s.startMs <= command.atMs && s.endMs >= command.atMs) ?? ordered.find(s => s.startMs >= command.atMs) ?? ordered.at(-1)
        if (!segment) throw new Error('This meeting has no finalized transcript passage yet. Retry after transcription finishes.')
        options.openLibrary()
        options.library.webContents.send('phase5:passage', { meetingId: command.id, segmentId: segment.id, atMs: segment.startMs,
          category: 'Transcript', targetId: segment.id, title: detail.meeting.title, text: segment.text, snippet: segment.text,
          source: segment.source, speaker: segment.speakerId ?? detail.speakers[segment.source] })
        return { message: 'Opened saved transcript passage.' }
      }
      case 'crm':
        await options.exclusive(command.id, async () => {
          const response = await dialog.showMessageBox(options.library, { type: 'question', title: 'Send to local mock CRM?',
            message: 'Send this meeting’s decisions and actions to ' + command.endpoint + '?',
            detail: 'This local demo receives notes, owners and due dates. It does not receive the transcript or audio.',
            buttons: ['Cancel', 'Send'], defaultId: 0, cancelId: 0 })
          if (response.response !== 1) return
          await sendMockCrm(store, command.id, command.endpoint, command.recordId)
        })
        return { message: 'Delivery operation finished. Refresh the session status to check whether it was sent.' }
      case 'detect':
        store.setSetting('meeting-detection', String(command.enabled))
        if (command.enabled) detector.start(); else detector.stop()
        return { message: command.enabled ? 'Call-window hints enabled. Browser meetings remain manual; detection never bypasses consent.' : 'Meeting detection disabled.', detecting: command.enabled }
      case 'encryption': {
        if (controller.snapshot().busy || ['recording','paused','stopping','processing'].includes(controller.getState())) throw new Error('Finish recording before requesting encryption.')
        const result = await dialog.showMessageBox(options.library, { type: 'warning', title: 'Enable Windows EFS?',
          message: 'Encrypt the Vinxa profile on the next launch?', detail: 'Requires a Windows edition and NTFS drive supporting EFS. Windows manages the encryption keys. Back up your EFS certificate with cipher /x. Losing the Windows key can make recordings unrecoverable. Exports outside the profile are not covered.',
          buttons: ['Cancel', 'Enable on next launch'], defaultId: 0, cancelId: 0 })
        if (result.response !== 1) return { message: 'Encryption request cancelled.' }
        requestEncryption(store.userData)
        return { message: 'Quit using the tray, then reopen Vinxa. Check encryption status here after restart.' }
      }
      case 'cluster': {
        const count = await options.exclusive(command.id, () => clusterMeeting(store, command.id, lifetime.signal))
        options.changed()
        return { message: 'Cluster labels saved for ' + count + ' remote transcript segments. Mixed segments keep Remote. Existing notes are unchanged; regenerate them if needed.' }
      }
      case 'ask': {
        const passages = askMeetings(store, command.question)
        return { message: passages.length ? 'Matching transcript evidence follows. These are exact excerpts, not an inferred answer; review their context.' : 'Not found in saved transcript evidence.', passages }
      }
      case 'speech':
        if (!installedSpeechModel(process.resourcesPath, command.value.model)) throw new Error('Download this speech model locally before selecting it.')
        saveSpeechTuning(store.userData, command.value)
        // Keep existing model settings and startup tuning aligned.
        const saved = savedNotesSettings(store)
        store.setSetting('notes', JSON.stringify({ ...saved, speechModel: command.value.model }))
        return { message: 'Speech configuration saved. Quit and reopen Vinxa to apply it. Benchmark before choosing it for a demo.', speech: command.value }
    }
  }
  ipcMain.handle(phase5Channel, (event, input: unknown) => {
    if (disposed || options.library.isDestroyed() || options.library.webContents.mainFrame !== event.senderFrame) throw new Error('Untrusted tools request.')
    const work = request(input).then(value => phase5ResultSchema.parse(value))
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  })
  return { bookmark, async close() {
    disposed = true
    lifetime.abort()
    detector.close()
    ipcMain.removeHandler(phase5Channel)
    await Promise.allSettled(pending)
  } }
}
