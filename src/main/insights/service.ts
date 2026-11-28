import type { TranscriptSegment } from '../../shared/contracts'
import { citedNotesSchema } from './prompts'
import type { CitedNotes } from './prompts'
import type { NotesProvider, NotesGenerationResult } from '../../shared/meetings'
import { transcriptChunks } from './chunking'
import { transcriptPrompt, consolidationPrompt } from './prompts'
import { ProviderUnavailable } from './http'
import { InvalidProviderResponse } from './http'
import { ZodError } from 'zod'

export async function generateNotes(provider: NotesProvider, transcript: TranscriptSegment[], chunkCharacters: number): Promise<NotesGenerationResult> {
  const metrics: NotesGenerationResult['metrics'] = []
  try {
    // Short references keep prompts small even when stored segment IDs are UUIDs.
    const segments = new Map(transcript.map((segment, index) => [String(index + 1), segment]))
    const chunks = transcriptChunks(Array.from(segments, ([id, segment]) => ({ ...segment, id })), chunkCharacters)
    if (!chunks.length) return { status: 'completed', insights: { summary: '', decisions: [], actionItems: [] },
      message: 'The transcript is empty.', metrics }
    const availability = await provider.available()
    if (!availability.available) return { status: 'pending', message: availability.message ?? 'Notes provider unavailable.', metrics }
    function sourceIds(notes: CitedNotes): string[] {
      return [notes.summarySourceId, ...notes.decisions.map(item => item.sourceId), ...notes.actionItems.map(item => item.sourceId)]
        .filter((id): id is string => id !== null)
    }
    async function validated(prompt: string, phase: string, allowed: Set<string>): Promise<CitedNotes> {
      let validationError = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now()
        let responded = false
        try {
          const response = await provider.generate({ prompt: prompt + (validationError ? '\nCorrect this validation error and return the complete JSON again: ' + validationError : '') })
          responded = true
          metrics.push({ phase, ...response.metrics, retries: attempt })
          const value = citedNotesSchema.parse(JSON.parse(response.content))
          if ((value.summary.trim() && !value.summarySourceId) || sourceIds(value).some(id => !allowed.has(id))) {
            throw new Error('Copy each supporting transcript id from the supplied evidence.')
          }
          if (value.decisions.some(decision => {
            const segment = segments.get(decision.sourceId)!
            return decision.atMs < segment.startMs || decision.atMs > segment.endMs
          })) {
            throw new Error('Each decision timestamp must fall inside an original transcript segment.')
          }
          return value
        } catch (error) {
          if (!responded) metrics.push({ phase, durationMs: performance.now() - started, retries: attempt })
          if (!responded && !(error instanceof ZodError) && !(error instanceof InvalidProviderResponse)) throw error
          validationError = error instanceof Error ? error.message.slice(0, 1800) : 'Invalid notes JSON.'
        }
      }
      throw new Error('The notes response failed validation twice. The recording is saved; retry notes after checking the model.')
    }
    let notes: CitedNotes[] = []
    for (const [index, chunk] of chunks.entries()) {
      const allowed = new Set<string>(chunk.split('\n').map(line => JSON.parse(line).id))
      notes.push(await validated(transcriptPrompt(chunk), 'chunk-' + (index + 1), allowed))
    }
    // Pairwise consolidation bounds each request and retains odd final groups.
    let level = 0
    while (notes.length > 1) {
      const next: CitedNotes[] = []
      for (let index = 0; index < notes.length; index += 2) {
        if (!notes[index + 1]) next.push(notes[index])
        else {
          const pair = notes.slice(index, index + 2)
          next.push(await validated(consolidationPrompt(JSON.stringify(pair)), 'consolidation-' + level, new Set(pair.flatMap(sourceIds))))
        }
      }
      notes = next
      level++
    }
    const insights = notes[0]
    const decisionKeys = new Set<string>(), actionKeys = new Set<string>()
    insights.decisions = insights.decisions.filter(item => {
      const key = item.text.trim().toLocaleLowerCase()
      if (decisionKeys.has(key)) return false
      decisionKeys.add(key); return true
    })
    insights.actionItems = insights.actionItems.filter(item => {
      const key = JSON.stringify([item.task.trim().toLocaleLowerCase(), item.owner?.trim().toLocaleLowerCase() ?? null, item.due])
      if (actionKeys.has(key)) return false
      actionKeys.add(key); return true
    })
    return { status: 'completed', metrics, message: 'Notes generated.',
      sources: { summary: insights.summarySourceId ? segments.get(insights.summarySourceId)!.id : null,
        decisions: insights.decisions.map(item => segments.get(item.sourceId)!.id),
        actions: insights.actionItems.map(item => segments.get(item.sourceId)!.id) },
      insights: { summary: insights.summary, decisions: insights.decisions.map(({ sourceId, ...item }) => item),
        actionItems: insights.actionItems.map(({ sourceId, ...item }) => item) } }
  } catch (error) {
    return { status: error instanceof ProviderUnavailable ? 'pending' : 'failed',
      message: error instanceof Error ? error.message : 'Notes generation failed.', metrics }
  }
}
