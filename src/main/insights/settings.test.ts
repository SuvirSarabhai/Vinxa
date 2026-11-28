import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeetingStore } from '../db/repository'
import { NotesSettingsStore } from './settings'
import { notesSettingsSchema } from '../../shared/meetings'
const stores: MeetingStore[] = []
function setup() {
  const store = new MeetingStore(mkdtempSync(join(tmpdir(), 'vinxa-keys-')))
  stores.push(store)
  // Reversible fake encryption only for testing the storage boundary, not Windows DPAPI.
  const encryption = { isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (s: Buffer) => s.toString().split('').reverse().join('') }
  return { store, encryption, settings: new NotesSettingsStore(store, encryption) }
}
afterEach(() => { for(const store of stores.splice(0)) { if(store.db.open) store.close(); rmSync(store.userData, {recursive:true, force:true}) } })
describe('notes settings with mocked OS encryption', () => {
  it('defaults to local only and returns no key in settings or plaintext database fields', () => {
    const {store, settings} = setup()
    expect(settings.get()).toMatchObject({provider:'ollama',cloudEnabled:false,apiKeyConfigured:false})
    const view = settings.save({...notesSettingsSchema.parse({}),apiKey:'fake-secret'})
    expect(view).not.toHaveProperty('apiKey')
    expect(JSON.stringify(store.db.prepare('SELECT * FROM settings').all())).not.toContain('fake-secret')
    expect(settings.key()).toBe('fake-secret')
    expect(view.apiKeyConfigured).toBe(true)
    settings.save({...notesSettingsSchema.parse({}),clearApiKey:true})
    expect(settings.key()).toBeUndefined()
  })
  it('rejects insecure key writes atomically and reports decrypt failures', () => {
    const {store, settings, encryption} = setup()
    encryption.isEncryptionAvailable=()=>false
    expect(()=>settings.save({...notesSettingsSchema.parse({}),apiKey:'fake-secret'})).toThrow('unavailable')
    expect(store.setting('notes')).toBeUndefined()
    encryption.isEncryptionAvailable=()=>true
    settings.save({...notesSettingsSchema.parse({}),apiKey:'fake-secret'})
    encryption.decryptString=()=>{throw new Error('DPAPI error')}
    expect(()=>settings.key()).toThrow('decrypted')
  })
})
