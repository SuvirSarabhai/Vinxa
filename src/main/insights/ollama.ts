import { z } from 'zod'
import type { NotesProvider, NotesRequest } from '../../shared/meetings'
import { notesResponseSchema } from './prompts'
import { requestJson, ProviderUnavailable } from './http'
import type { Fetcher } from './http'
import { guardedFetch } from '../network-guard'
const responseSchema = z.object({
  message: z.object({ content: z.string() }), done: z.literal(true),
  load_duration: z.number().nonnegative().optional(), prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional()
})
export class OllamaNotesProvider implements NotesProvider {
  readonly name = 'ollama'
  constructor(readonly model: string, private readonly timeoutMs: number, private readonly fetcher: Fetcher = guardedFetch) {}
  async available() {
    if (!this.model.trim()) return { available: false, message: 'Choose an installed Ollama model in Settings.' }
    try {
      const value = await requestJson(this.fetcher, 'http://127.0.0.1:11434/api/tags', {}, 5000)
      const data = z.object({ models: z.array(z.object({ name: z.string(), remote_host: z.string().optional(), remote_model: z.string().optional() })) }).parse(value)
      const found = data.models.find(item => item.name === this.model || item.name === this.model + ':latest')
      if (found && (found.remote_host || found.remote_model || /:cloud(?:-|$)/i.test(found.name))) {
        return { available: false, message: 'Select a downloaded local Ollama model. Remote Ollama models are not allowed for local notes.' }
      }
      return { available: Boolean(found), message: found ? undefined : 'The configured Ollama model is missing. Install it in Ollama, then generate notes again.' }
    } catch { return { available: false, message: 'Ollama is unavailable. Start Ollama and select an installed local model in Settings.' } }
  }
  async generate(request: NotesRequest) {
    if (!this.model) throw new ProviderUnavailable('Choose an Ollama model in Settings.')
    const availability = await this.available()
    if (!availability.available) throw new ProviderUnavailable(availability.message)
    const started = performance.now()
    const format = z.toJSONSchema(notesResponseSchema(true, request.allowedSourceIds))
    const result = responseSchema.parse(await requestJson(this.fetcher, 'http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, stream: false, think: false, keep_alive: '5m',
        format, options: { temperature: 0, num_predict: 1024 },
        messages: [{ role: 'system', content: 'Return only the JSON required by the output schema. Use exact supporting transcript reference strings. Do not output atMs: the app assigns decision timestamps from those references. Keep notes concise; never invent missing evidence.\nRESPONSE SCHEMA\n' + JSON.stringify(format) },
          { role: 'user', content: request.prompt }] })
    }, this.timeoutMs))
    return { content: result.message.content, metrics: { durationMs: performance.now() - started,
      loadMs: result.load_duration === undefined ? undefined : result.load_duration / 1e6,
      inputTokens: result.prompt_eval_count, outputTokens: result.eval_count } }
  }
}
