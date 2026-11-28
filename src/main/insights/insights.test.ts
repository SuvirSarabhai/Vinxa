import { describe, expect, it, vi } from 'vitest'
import { OllamaNotesProvider } from './ollama'
import { OpenAINotesProvider } from './openai'
import { generateNotes } from './service'
import { transcriptChunks } from './chunking'
import type { NotesProvider, NotesRequest } from '../../shared/meetings'
import type { TranscriptSegment } from '../../shared/contracts'
const insights = { summary: 'A review was agreed.', summarySourceId: '1', decisions: [{ sourceId: '1', text: 'Review tomorrow', atMs: 2000 }],
  actionItems: [{ sourceId: '1', task: 'Review', owner: null, due: null, status: 'pending' }] }
const segment: TranscriptSegment = { id: 'a', meetingId: 'meeting', source: 'mic', speakerId: 'you',
  text: 'I will review the plan.', startMs: 2000, endMs: 3000, isFinal: true }
function provider(content = JSON.stringify(insights)) {
  return { name: 'mock', model: 'mock', available: vi.fn(async () => ({ available: true })),
    generate: vi.fn(async (_request: NotesRequest) => ({ content, metrics: { durationMs: 1 } })) } satisfies NotesProvider
}
function fetchJson(value: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status }))
}
describe('notes providers (mock HTTP)', () => {
  it('checks an installed Ollama model and uses structured offline JSON output', async () => {
    const fetcher = fetchJson({ models: [{ name: 'local:latest' }] })
    const target = new OllamaNotesProvider('local', 1000, fetcher)
    expect((await target.available()).available).toBe(true)
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'local:latest' }] })))
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: JSON.stringify(insights) }, done: true, load_duration: 2e6 })))
    expect((await target.generate({ prompt: 'transcript text' })).metrics.loadMs).toBe(2)
    const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))
    expect(body.format.type).toBe('object')
    expect(body.stream).toBe(false)
    expect(fetcher.mock.calls.every(call => String(call[0]).startsWith('http://127.0.0.1:11434/'))).toBe(true)
  })
  it('reports unavailable service and missing local model without cloud fallback', async () => {
    const fetcher = fetchJson({ models: [] })
    expect((await new OllamaNotesProvider('missing', 1000, fetcher).available()).available).toBe(false)
    fetcher.mockRejectedValueOnce(new Error('connection refused'))
    expect((await new OllamaNotesProvider('local', 1000, fetcher).available()).message).toContain('unavailable')
  })
  it('never calls OpenAI when cloud notes are disabled, including direct generate', async () => {
    const fetcher = fetchJson({})
    const target = new OpenAINotesProvider('model', () => 'test-key', () => false, 1000, fetcher)
    expect((await target.available()).available).toBe(false)
    await expect(target.generate({ prompt: 'private transcript' })).rejects.toThrow('disabled')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects remote Ollama aliases before sending transcript text', async () => {
    const fetcher = fetchJson({ models: [{ name: 'alias', remote_host: 'https://ollama.com', remote_model: 'remote' }] })
    const target = new OllamaNotesProvider('alias', 1000, fetcher)
    await expect(target.generate({ prompt: 'private text' })).rejects.toThrow('Remote Ollama')
    expect(fetcher.mock.calls.every(call => call[1]?.body === undefined)).toBe(true)
  })
  it('sends text only with structured output and cloud opt-in', async () => {
    const fetcher = fetchJson({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(insights) }] }] })
    const target = new OpenAINotesProvider('configured-model', () => 'test-key', () => true, 1000, fetcher)
    expect((await target.generate({ prompt: 'approved transcript text' })).content).toBe(JSON.stringify(insights))
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body))
    expect(body).toMatchObject({ store: false, input: 'approved transcript text', text: { format: { type: 'json_schema', strict: true } } })
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'store', 'text'])
  })
  it.each([401,429,500])('handles provider HTTP %s', async status => {
    const target = new OpenAINotesProvider('model', () => 'test-key', () => true, 1000, fetchJson({}, status))
    await expect(target.generate({ prompt: 'text' })).rejects.toThrow('provider')
  })
  it('handles timeouts and malformed provider envelopes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('deadline', 'TimeoutError'))
    const target = new OpenAINotesProvider('model', () => 'test-key', () => true, 1000, fetcher)
    await expect(target.generate({ prompt: 'text' })).rejects.toThrow('timed out')
    await expect(new OllamaNotesProvider('local', 1000, fetchJson({})).generate({ prompt: 'text' })).rejects.toThrow()
  })
})
describe('notes pipeline (mock model)', () => {
  it('returns pending when no provider is available', async () => {
    const model = provider(); model.available.mockResolvedValue({ available: false })
    expect((await generateNotes(model, [segment], 6000)).status).toBe('pending')
    expect(model.generate).not.toHaveBeenCalled()
  })
  it('handles empty transcripts explicitly without a provider request', async () => {
    const model = provider()
    expect((await generateNotes(model, [], 6000)).insights).toEqual({ summary: '', decisions: [], actionItems: [] })
    expect(model.generate).not.toHaveBeenCalled()
  })
  it('retries validation exactly once with the validation error', async () => {
    const model = provider()
    model.generate.mockResolvedValueOnce({ content: '{"summary":4}', metrics: { durationMs: 1 } })
    const result = await generateNotes(model, [segment], 6000)
    expect(result.status).toBe('completed')
    expect(model.generate).toHaveBeenCalledTimes(2)
    expect(model.generate.mock.calls[1][0].prompt).toContain('Correct this validation error')
  })
  it('returns controlled failure after two invalid responses', async () => {
    const model = provider('{"summary":"unsupported"}')
    const result = await generateNotes(model, [segment], 6000)
    expect(result.status).toBe('failed'); expect(result.insights).toBeUndefined()
    expect(model.generate).toHaveBeenCalledTimes(2)
  })
  it('retries malformed response envelopes once and does not retry network failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({broken:true}))
    const model = new OpenAINotesProvider('model',()=> 'fake-key',()=>true,1000,fetcher)
    const result = await generateNotes(model,[segment],6000)
    expect(result.status).toBe('failed')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.metrics).toHaveLength(2)
    fetcher.mockClear().mockRejectedValue(new Error('network'))
    expect((await generateNotes(model,[segment],6000)).status).toBe('pending')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects unsupported decision timestamps and incomplete transcripts', async () => {
    const model = provider(JSON.stringify({ ...insights, decisions: [{ text: 'Decision', sourceId: '1', atMs: 999999 }] }))
    expect((await generateNotes(model, [segment], 6000)).status).toBe('failed')
    expect((await generateNotes(provider(JSON.stringify({ ...insights, summarySourceId: '999' })), [segment], 6000)).status).toBe('failed')
    const pending = provider()
    expect((await generateNotes(pending, [{ ...segment, isFinal: false }], 6000)).status).toBe('failed')
    expect(pending.generate).not.toHaveBeenCalled()
  })
  it('retains speaker, source and original timestamps without splitting a segment', () => {
    const chunks = transcriptChunks([{ ...segment, id: 'b', source: 'system', startMs: 6000, endMs: 7000 }, segment], 50)
    expect(chunks).toHaveLength(2)
    expect(JSON.parse(chunks[0])).toMatchObject({ startMs: 2000, source: 'mic', speaker: 'You' })
    expect(JSON.parse(chunks[1])).toMatchObject({ startMs: 6000, speaker: 'Remote' })
  })
  it('keeps the final chunk and consolidates long transcripts with deduplication', async () => {
    const model = provider()
    for (const id of ['1', '2', '3']) model.generate.mockResolvedValueOnce({
      content: JSON.stringify(insights).replaceAll('"1"', JSON.stringify(id)), metrics: { durationMs: 1 }
    })
    const result = await generateNotes(model, [segment, { ...segment, id: 'b' }, { ...segment, id: 'c' }], 50)
    expect(result.status).toBe('completed')
    expect(model.generate).toHaveBeenCalledTimes(5)
    expect(result.metrics.filter(m => m.phase.startsWith('chunk'))).toHaveLength(3)
    expect(result.insights?.actionItems[0].owner).toBeNull()
  })
})
