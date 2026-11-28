import { z } from 'zod'
import { meetingIdSchema } from './meetings'
export const searchQuerySchema = z.string().max(500)
export const searchResultSchema = z.object({
  meetingId: meetingIdSchema, title: z.string(), category: z.enum(['Transcript','Summary','Decision','Action item']),
  segmentId: z.string().nullable(), targetId: z.string(), text: z.string(), snippet: z.string(), source: z.enum(['mic','system']).nullable(),
  speaker: z.string().nullable(), atMs: z.number().nonnegative().nullable()
})
export const searchResultsSchema = z.array(searchResultSchema)
export type SearchResult = z.infer<typeof searchResultSchema>
export const exportRequestSchema = z.object({ id: meetingIdSchema, format: z.enum(['markdown','pdf']) }).strict()
export const fileResultSchema = z.object({ cancelled: z.boolean(), path: z.string().optional() }).strict()
export const phase4StatusSchema = z.object({
  localOnly: z.boolean(), provider: z.string(), blocked: z.number().int().nonnegative(),
  allowedCloud: z.number().int().nonnegative(), pendingNotes: z.number().int().nonnegative(),
  providerMessage: z.string(), storageWarning: z.string(), storageLocation: z.string()
}).strict()
export type Phase4Status = z.infer<typeof phase4StatusSchema>
export interface Phase4Api {
  search(query: string): Promise<SearchResult[]>
  exportMeeting(input: z.infer<typeof exportRequestSchema>): Promise<z.infer<typeof fileResultSchema>>
  deleteMeeting(id: string): Promise<{ cancelled: boolean }>
  recoverMeeting(id: string): Promise<void>
  status(): Promise<Phase4Status>
  retryPending(): Promise<void>
}
