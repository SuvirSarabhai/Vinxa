import type { MeetingStore } from '../db/repository'
import type { NotesSettingsStore } from './settings'
import type { NotesProvider } from '../../shared/meetings'
import { OllamaNotesProvider } from './ollama'
import { OpenAINotesProvider } from './openai'
import { generateNotes } from './service'

export class MeetingNotesService {
  private running = new Map<string, Promise<void>>()
  constructor(private readonly store: MeetingStore, private readonly settings: NotesSettingsStore,
    private readonly changed: () => void,
    private readonly providerFactory?: () => NotesProvider) {}
  generate(id: string): Promise<void> {
    const current = this.running.get(id)
    if (current) return current
    const operation = this.run(id).finally(() => this.running.delete(id))
    this.running.set(id, operation)
    return operation
  }
  async drain(): Promise<void> { await Promise.all(this.running.values()) }
  isRunning(id?: string): boolean { return id ? this.running.has(id) : this.running.size > 0 }
  private async run(id: string): Promise<void> {
    if (!['completed', 'processing'].includes(this.store.meeting(id).recordingStatus)) throw new Error('Finish saving the recording before generating notes.')
    const hasSavedNotes = this.store.get(id).insights !== null
    const retainPrevious = (message: string): void => {
      this.store.notesStatus(id, hasSavedNotes ? 'completed' : 'failed',
        hasSavedNotes ? 'Previous notes retained. Regeneration failed: ' + message : message)
    }
    try {
      const settings = this.settings.get()
      const provider = this.providerFactory?.() ?? (settings.provider === 'openai'
        ? new OpenAINotesProvider(settings.openaiModel, () => this.settings.key(),
          () => { const latest = this.settings.get(); return latest.cloudEnabled && latest.provider === 'openai' },
          settings.timeoutSeconds * 1000)
        : new OllamaNotesProvider(settings.ollamaModel, settings.timeoutSeconds * 1000))
      this.store.notesStatus(id, 'processing', 'Generating meeting notes.')
      this.changed()
      const result = await generateNotes(provider, this.store.transcript(id), settings.chunkCharacters)
      if (result.status === 'completed' && result.insights) this.store.replaceInsights(id, result.insights, provider.name, provider.model, result.sources)
      else if (hasSavedNotes) retainPrevious(result.message)
      else this.store.notesStatus(id, result.status === 'completed' ? 'failed' : result.status, result.message)
    } catch {
      retainPrevious('Notes could not be generated or saved. Check Settings and retry.')
    } finally { this.changed() }
  }
}
