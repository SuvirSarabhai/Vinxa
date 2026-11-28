import { notesSettingsSchema, settingsUpdateSchema, settingsViewSchema } from '../../shared/meetings'
import type { MeetingStore } from '../db/repository'
export interface KeyEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export function savedNotesSettings(store: MeetingStore) {
  const raw = store.setting('notes')
  return notesSettingsSchema.parse(raw ? JSON.parse(raw) : {})
}
export class NotesSettingsStore {
  constructor(private readonly store: MeetingStore, private readonly encryption: KeyEncryption) {}
  get() {
    return settingsViewSchema.parse({ ...savedNotesSettings(this.store),
      apiKeyConfigured: Boolean(this.store.setting('openai-key')) })
  }
  key(): string | undefined {
    const stored = this.store.setting('openai-key')
    if (!stored) return undefined
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows secure key storage is unavailable.')
    try { return this.encryption.decryptString(Buffer.from(stored, 'base64')) }
    catch { throw new Error('The saved API key could not be decrypted. Enter it again in Settings.') }
  }
  save(input: unknown) {
    const { apiKey, clearApiKey, ...settings } = settingsUpdateSchema.parse(input)
    if (apiKey && clearApiKey) throw new Error('Choose either replacing or clearing the key.')
    let encrypted: string | undefined
    if (apiKey) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows secure key storage is unavailable.')
      encrypted = this.encryption.encryptString(apiKey).toString('base64')
    }
    this.store.db.transaction(() => {
      this.store.setSetting('notes', JSON.stringify(settings))
      if (encrypted !== undefined) this.store.setSetting('openai-key', encrypted)
      if (clearApiKey) this.store.setSetting('openai-key', '')
    })()
    return this.get()
  }
}
