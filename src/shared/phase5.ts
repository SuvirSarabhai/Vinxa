import { z } from 'zod'

export const phase5Channel = 'phase5:request'
export const bookmarkSchema = z.object({ id: z.string().uuid(), meetingId: z.string().uuid(), atMs: z.number().int().nonnegative(), note: z.string().max(240) })
export const speechTuningSchema = z.object({
  language: z.enum(['en', 'hi']), model: z.enum(['tiny.en', 'base.en', 'small']),
  vadThreshold: z.number().min(0.1).max(0.95), vadRelease: z.number().min(0.05).max(0.9)
}).strict().refine(v => v.vadRelease <= v.vadThreshold, 'VAD release must not exceed onset')
export const phase5RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('overview') }).strict(),
  z.object({ type: z.literal('detail'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('bookmark') }).strict(),
  z.object({ type: z.literal('remove-bookmark'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('open-passage'), id: z.string().uuid(), atMs: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('crm'), id: z.string().uuid(), endpoint: z.string().url().max(500), recordId: z.string().trim().min(1).max(120) }).strict(),
  z.object({ type: z.literal('detect'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('encryption') }).strict(),
  z.object({ type: z.literal('cluster'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('ask'), question: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('speech'), value: speechTuningSchema }).strict()
])
export type Phase5Request = z.infer<typeof phase5RequestSchema>
export type Bookmark = z.infer<typeof bookmarkSchema>
export const passageSchema = z.object({ meetingId: z.string().uuid(), title: z.string(), segmentId: z.string(), speaker: z.string(), atMs: z.number(), text: z.string() })
export const phase5ResultSchema = z.object({
  message: z.string(), meetings: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  bookmarks: z.array(bookmarkSchema).optional(), passages: z.array(passageSchema).optional(),
  detecting: z.boolean().optional(), encryption: z.string().optional(),
  crm: z.array(z.object({ recordId: z.string(), endpoint: z.string(), status: z.string(), sentAt: z.number().nullable() })).optional(),
  speech: speechTuningSchema.optional()
})
export type Phase5Result = z.infer<typeof phase5ResultSchema>
export interface Phase5Api {
  request(input: Phase5Request): Promise<Phase5Result>
  onPassage(listener: (target: import('./phase4').SearchResult) => void): () => void
  onOpenTools(listener: () => void): () => void
}
