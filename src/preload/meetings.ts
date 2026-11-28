import { ipcRenderer } from 'electron'
import { ipcChannels } from '../shared/ipc-channels'
import { librarySchema, meetingDetailSchema, meetingIdSchema, meetingCommandSchema,
  settingsViewSchema, settingsUpdateSchema } from '../shared/meetings'
import type { MeetingsApi } from '../shared/meetings'
import { searchQuerySchema, searchResultsSchema, exportRequestSchema, fileResultSchema, phase4StatusSchema } from '../shared/phase4'
import { z } from 'zod'
export function createMeetingsApi(): MeetingsApi {
  return {
    async search(query) { return searchResultsSchema.parse(await ipcRenderer.invoke(ipcChannels.meetingsSearch, searchQuerySchema.parse(query))) },
    async exportMeeting(input) { return fileResultSchema.parse(await ipcRenderer.invoke(ipcChannels.meetingsExport, exportRequestSchema.parse(input))) },
    async deleteMeeting(id) { return z.object({cancelled:z.boolean()}).parse(await ipcRenderer.invoke(ipcChannels.meetingsDelete, meetingIdSchema.parse(id))) },
    async recoverMeeting(id) { await ipcRenderer.invoke(ipcChannels.meetingsRecover, meetingIdSchema.parse(id)) },
    async status() { return phase4StatusSchema.parse(await ipcRenderer.invoke(ipcChannels.privacyStatus)) },
    async retryPending() { await ipcRenderer.invoke(ipcChannels.notesRetryPending) },
    async list() { return librarySchema.parse(await ipcRenderer.invoke(ipcChannels.meetingsList)) },
    async get(id) { return meetingDetailSchema.parse(await ipcRenderer.invoke(ipcChannels.meetingsGet, meetingIdSchema.parse(id))) },
    async command(input) {
      const command = meetingCommandSchema.parse(input)
      const channels = { rename: ipcChannels.meetingsRename, speaker: ipcChannels.speakerRename,
        action: ipcChannels.actionUpdate, notes: ipcChannels.notesGenerate }
      return meetingDetailSchema.parse(await ipcRenderer.invoke(channels[command.type], command))
    },
    async settings() { return settingsViewSchema.parse(await ipcRenderer.invoke(ipcChannels.settingsGet)) },
    async saveSettings(input) { return settingsViewSchema.parse(await ipcRenderer.invoke(ipcChannels.settingsSet, settingsUpdateSchema.parse(input))) },
    onChange(listener) {
      const handler = (): void => listener()
      ipcRenderer.on(ipcChannels.meetingsChanged, handler)
      return () => ipcRenderer.removeListener(ipcChannels.meetingsChanged, handler)
    }
  }
}
