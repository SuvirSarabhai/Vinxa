import { z } from 'zod'
import type { NotesProvider, NotesRequest } from '../../shared/meetings'
import { notesResponseSchema } from './prompts'
import { requestJson, ProviderUnavailable } from './http'
import type { Fetcher } from './http'
import { guardedFetch } from '../network-guard'
const responseSchema = z.object({
  status: z.string(), output: z.array(z.object({
    type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional()
  })),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional()
})
export class OpenAINotesProvider implements NotesProvider {
  readonly name = 'openai'
  constructor(readonly model: string, private readonly key: () => string | undefined,
    private readonly enabled: () => boolean, private readonly timeoutMs: number, private readonly fetcher: Fetcher = guardedFetch) {}
  async available() {
    if (!this.enabled()) return { available: false, message: 'Cloud notes are disabled. Enable them explicitly in Settings to use OpenAI.' }
    if (!this.model || !this.key()) return { available: false, message: 'Set an OpenAI model and API key in Settings.' }
    return { available: true }
  }
  async generate(request: NotesRequest) {
    if (!this.enabled()) throw new ProviderUnavailable('Cloud notes are disabled.')
    const apiKey = this.key()
    if (!apiKey || !this.model) throw new ProviderUnavailable('OpenAI model or API key is missing.')
    const started = performance.now()
    const result = responseSchema.parse(await requestJson(this.fetcher, 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: this.model, store: false, input: request.prompt,
        text: { format: { type: 'json_schema', name: 'meeting_insights', strict: true, schema: z.toJSONSchema(notesResponseSchema(false, request.allowedSourceIds)) } } })
    }, this.timeoutMs))
    if (result.status !== 'completed') throw new Error('OpenAI did not complete the notes response.')
    const content = result.output.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text ?? '').join('')
    return { content, metrics: { durationMs: performance.now() - started, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens } }
  }
}
