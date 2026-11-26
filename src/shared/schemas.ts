import { z } from 'zod'

export const audioSourceSchema = z.enum(['mic', 'system'])
export const recordingStateSchema = z.enum([
  'idle', 'awaiting-consent', 'recording', 'paused', 'stopping',
  'processing', 'completed', 'interrupted', 'error'
])
const milliseconds = z.number().int().nonnegative()
export const transcriptSegmentSchema = z.object({
  id: z.string().min(1), meetingId: z.string().min(1), source: audioSourceSchema,
  speakerId: z.string().nullable(), text: z.string(), startMs: milliseconds,
  endMs: milliseconds, isFinal: z.boolean()
}).strict().refine((segment) => segment.endMs >= segment.startMs, {
  message: 'endMs must be at least startMs', path: ['endMs']
})
export const recordingConfigSchema = z.object({
  title: z.string().trim().min(1), microphoneEnabled: z.boolean(),
  systemAudioEnabled: z.boolean(), microphoneDeviceId: z.string().nullable()
}).strict().refine((config) => config.microphoneEnabled || config.systemAudioEnabled, {
  message: 'Select at least one audio source'
})
export const meetingInsightsSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.object({ text: z.string().min(1), atMs: milliseconds }).strict()),
  actionItems: z.array(z.object({
    task: z.string().min(1), owner: z.string().nullable(), due: z.string().nullable(),
    status: z.enum(['pending', 'done'])
  }).strict())
}).strict()
export const sidecarConfigSchema = z.object({
  type: z.literal('config'), token: z.string().min(1), sampleRate: z.literal(16000),
  channels: z.literal(1), encoding: z.literal('pcm_s16le'), frameMs: z.literal(100),
  model: z.string().min(1), language: z.string().nullable()
}).strict()
export const sidecarEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('partial'), source: audioSourceSchema, text: z.string(), startMs: milliseconds, endMs: milliseconds }).strict(),
  z.object({ type: z.literal('final'), source: audioSourceSchema, text: z.string(), startMs: milliseconds, endMs: milliseconds }).strict(),
  z.object({ type: z.literal('status'), status: z.enum(['loading', 'ready', 'stopped']) }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict()
]).refine((event) => !('endMs' in event) || event.endMs >= event.startMs, {
  message: 'endMs must be at least startMs'
})
export const fixtureCommandSchema = z.enum(['play', 'pause', 'stop'])
export const fixtureStatusSchema = z.enum(['idle', 'playing', 'paused', 'completed'])
