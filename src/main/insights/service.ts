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
      if (!allowed.size) throw new Error(phase + ': no supporting evidence is available for this notes request.')
      const allowedSourceIds = [...allowed]
      const referenceInstructions = '\nALLOWED_REFERENCE_IDS_JSON\n' + JSON.stringify(allowedSourceIds) +
        '\nCopy reference strings exactly from this list. For a nonempty summary select one representative supporting reference. Do not output null for a nonempty summary.'
      let validationError = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now()
        let responded = false
        try {
          const response = await provider.generate({ allowedSourceIds,
            prompt: prompt + referenceInstructions + (validationError ? '\nCorrect this validation error and return the complete JSON again: ' + validationError : '') })
          responded = true
          metrics.push({ phase, ...response.metrics, retries: attempt })
          const parsed: unknown = JSON.parse(response.content)
          if (parsed && typeof parsed === 'object' && 'summary' in parsed &&
            typeof parsed.summary === 'string' && !parsed.summary.trim()) {
            Object.assign(parsed, { summarySourceId: null })
          }
          // Fill only absent timestamps, and only from an actual allowed
          // reference. Explicit invalid timestamps and unknown ids still fail.
          if (parsed && typeof parsed === 'object' && 'decisions' in parsed && Array.isArray(parsed.decisions)) {
            for (const decision of parsed.decisions) {
              if (decision && typeof decision === 'object' && !('atMs' in decision) &&
                typeof decision.sourceId === 'string' && allowed.has(decision.sourceId)) {
                const source = segments.get(decision.sourceId)
                if (source) decision.atMs = source.startMs
              }
            }
          }
          const value = citedNotesSchema.parse(parsed)
          if (value.summary.trim() && !value.summarySourceId) {
            throw new Error('summarySourceId: select a supporting ID from ALLOWED_REFERENCE_IDS_JSON for the nonempty summary.')
          }
          const references = [
            { path: 'summarySourceId', id: value.summarySourceId },
            ...value.decisions.map((item, index) => ({ path: `decisions.${index}.sourceId`, id: item.sourceId })),
            ...value.actionItems.map((item, index) => ({ path: `actionItems.${index}.sourceId`, id: item.sourceId }))
          ]
          const invalid = references.find(item => item.id !== null && !allowed.has(item.id))
          if (invalid) throw new Error(invalid.path + ': reference is outside this request. Select an ID from ALLOWED_REFERENCE_IDS_JSON.')
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
          validationError = error instanceof ZodError
            ? error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : error instanceof SyntaxError ? 'Return a single valid JSON object with no Markdown or commentary.'
              : error instanceof Error ? error.message.slice(0, 300) : 'Invalid notes JSON.'
        }
      }
      throw new Error('The notes response failed validation twice (' + phase + '). ' + validationError.slice(0, 500) + ' Recording and transcript are saved; export remains available.')
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
          const nonempty = pair.filter(item => item.summary.trim() || item.decisions.length || item.actionItems.length)
          if (!nonempty.length) next.push({ summary: '', summarySourceId: null, decisions: [], actionItems: [] })
          else if (nonempty.length === 1) next.push(nonempty[0])
          else next.push(await validated(consolidationPrompt(JSON.stringify(pair)), 'consolidation-' + level, new Set(pair.flatMap(sourceIds))))
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
