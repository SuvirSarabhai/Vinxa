import { z } from 'zod'
import type { Phase4Api } from './phase4'
import { bookmarkSchema } from './phase5'
import { audioSourceSchema, meetingInsightsSchema, transcriptSegmentSchema } from './schemas'
import type { AudioFrameMetadata, AudioSourceName, MeetingInsights, RecordingConfig, TranscriptSegment } from './contracts'

export const MeetingInsightsSchema = meetingInsightsSchema
export const meetingIdSchema = z.string().uuid()
const title = z.string().trim().min(1).max(160)
const timestamp = z.number().int().nonnegative()
export const notesStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed'])
export const meetingSchema = z.object({
  id: meetingIdSchema, title, startedAt: timestamp, endedAt: timestamp.nullable(),
  duration: timestamp, recordingStatus: z.enum(['recording', 'paused', 'stopping', 'processing', 'completed', 'error', 'interrupted']),
  notesStatus: notesStatusSchema, microphoneAudioPath: z.string().nullable(), systemAudioPath: z.string().nullable(),
  createdAt: timestamp, updatedAt: timestamp, error: z.string().nullable(), notesMessage: z.string().nullable(),
  actionItemCount: timestamp, pendingActionCount: timestamp
}).strict()
export type Meeting = z.infer<typeof meetingSchema>
export const actionItemSchema = meetingInsightsSchema.shape.actionItems.element.extend({ id: z.string().uuid() })
export const meetingDetailSchema = z.object({
  meeting: meetingSchema, transcript: z.array(transcriptSegmentSchema),
  insights: meetingInsightsSchema.nullable(), actions: z.array(actionItemSchema),
  speakers: z.object({ mic: title, system: title }).strict(),
  bookmarks: z.array(bookmarkSchema).optional()
}).strict()
export type MeetingDetail = z.infer<typeof meetingDetailSchema>
export const librarySchema = z.object({
  meetings: z.array(meetingSchema),
  stats: z.object({ totalMeetings: timestamp, pendingActions: timestamp }).strict()
}).strict()
export type LibraryData = z.infer<typeof librarySchema>
export const speechModelSchema = z.enum(['default', 'tiny.en', 'base.en', 'small'])
export const notesSettingsSchema = z.object({
  speechModel: speechModelSchema.default('default'),
  provider: z.enum(['ollama', 'openai']).default('ollama'),
  cloudEnabled: z.boolean().default(false),
  ollamaModel: z.string().trim().max(160).default(''),
  openaiModel: z.string().trim().max(160).default(''),
  chunkCharacters: z.number().int().min(1000).max(24000).default(6000),
  timeoutSeconds: z.number().int().min(10).max(600).default(180)
}).strict()
export type NotesSettings = z.infer<typeof notesSettingsSchema>
export const settingsViewSchema = notesSettingsSchema.extend({ apiKeyConfigured: z.boolean() })
export const settingsUpdateSchema = notesSettingsSchema.extend({
  apiKey: z.string().trim().min(1).max(512).optional(), clearApiKey: z.boolean().optional()
})
export const meetingCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename'), id: meetingIdSchema, title }).strict(),
  z.object({ type: z.literal('speaker'), id: meetingIdSchema, source: audioSourceSchema, name: title }).strict(),
  z.object({ type: z.literal('action'), id: meetingIdSchema, actionId: z.string().uuid(), status: z.enum(['pending', 'done']) }).strict(),
  z.object({ type: z.literal('notes'), id: meetingIdSchema }).strict()
])
export type MeetingCommand = z.infer<typeof meetingCommandSchema>
export interface MeetingsApi extends Phase4Api {
  list(): Promise<LibraryData>
  get(id: string): Promise<MeetingDetail>
  command(value: MeetingCommand): Promise<MeetingDetail>
  settings(): Promise<z.infer<typeof settingsViewSchema>>
  saveSettings(value: z.input<typeof settingsUpdateSchema>): Promise<z.infer<typeof settingsViewSchema>>
  onChange(listener: () => void): () => void
}
export interface MeetingRepository {
  create(id: string, config: RecordingConfig, startedAt: number): Meeting
  list(): LibraryData
  get(id: string): MeetingDetail
  rename(id: string, value: string): void
  recording(id: string, status: Meeting['recordingStatus'], endedAt?: number, error?: string): void
  notesStatus(id: string, status: Meeting['notesStatus'], message?: string): void
  replaceInsights(id: string, insights: MeetingInsights, provider: string, model: string): void
}
export interface TranscriptRepository {
  saveFinal(segment: TranscriptSegment): void
  transcript(id: string): TranscriptSegment[]
}
export interface AudioSpooler {
  append(source: AudioSourceName, pcm: Uint8Array, metadata: AudioFrameMetadata): Promise<void>
  endSource(source: AudioSourceName, padding: number): Promise<void>
  finalize(): Promise<{ microphoneAudioPath: string | null; systemAudioPath: string | null }>
}
export interface NotesRequest { prompt: string; allowedSourceIds?: readonly string[] }
export interface ProviderResponse {
  content: string
  metrics: { durationMs: number; loadMs?: number; inputTokens?: number; outputTokens?: number }
}
export interface NotesProvider {
  readonly name: string
  readonly model: string
  available(): Promise<{ available: boolean; message?: string }>
  generate(request: NotesRequest): Promise<ProviderResponse>
}
export interface NoteSources {
  summary: string | null
  decisions: string[]
  actions: string[]
}
export interface NotesGenerationResult {
  sources?: NoteSources
  status: 'completed' | 'pending' | 'failed'
  insights?: MeetingInsights
  message: string
  metrics: { phase: string; durationMs: number; loadMs?: number; inputTokens?: number; outputTokens?: number; retries: number }[]
}
