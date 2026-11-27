import { z } from 'zod'

export const audioSourceSchema = z.enum(['mic', 'system'])
export const recordingStateSchema = z.enum([
  'idle', 'awaiting-consent', 'recording', 'paused', 'stopping',
  'processing', 'completed', 'interrupted', 'error'
])
const milliseconds = z.number().int().nonnegative()
export const transcriptTimingSchema = z.object({
  clock: z.enum(['sidecar-monotonic', 'sender-monotonic']), captureKind: z.enum(['render-estimate', 'replay']).optional(),
  firstSequence: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative(),
  captureStartMs: z.number().finite(), captureEndMs: z.number().finite(),
  sentMs: z.number().finite(), receivedMs: z.number().finite(),
  inferenceStartMs: z.number().finite(), inferenceEndMs: z.number().finite(),
  emittedMs: z.number().finite(), finalizationStartMs: z.number().finite().optional(), uncertaintyMs: z.number().finite().nonnegative()
}).strict()
export const transcriptSegmentSchema = z.object({
  id: z.string().min(1), meetingId: z.string().min(1), source: audioSourceSchema,
  speakerId: z.string().nullable(), text: z.string(), startMs: milliseconds,
  endMs: milliseconds, isFinal: z.boolean(), timing: transcriptTimingSchema.optional()
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
const samplePosition = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const sessionIdentity = { sessionId: z.string().uuid(), generation: samplePosition }
export const captureFrameDiagnosticsSchema = z.object({
  sequence: z.number().int().nonnegative(), producedSamples: z.number().int().nonnegative(),
  rendererFrames: z.number().int().nonnegative(), ipcFrames: z.number().int().nonnegative()
}).strict()
export const audioFrameMetadataSchema = z.object({
  startSample: samplePosition, sequence: samplePosition.max(4294967295).optional(),
  captureTimeMs: z.number().finite().optional(), captureErrorMs: z.number().finite().nonnegative().optional(),
  sampleCount: z.literal(1600).optional(), captureKind: z.enum(['render-estimate', 'replay']).optional()
}).strict()
const sidecarConfigFields = {
  type: z.literal('config'), keepAlive: z.boolean().optional(), standby: z.boolean().optional(), ...sessionIdentity,
  token: z.string().length(64).regex(/^[0-9a-f]{64}$/), sampleRate: z.literal(16000),
  channels: z.literal(1), encoding: z.literal('pcm_s16le'), frameMs: z.literal(100),
  model: z.string().min(1).max(80), language: z.string().min(1).max(32).nullable(),
  enabledSources: z.array(audioSourceSchema).min(1).max(2)
    .refine((sources) => new Set(sources).size === sources.length, 'Sources must be unique')
    .meta({ uniqueItems: true })
}
export const sidecarConfigSchema = z.discriminatedUnion('protocolVersion', [
  z.object({ ...sidecarConfigFields, protocolVersion: z.literal(1) }).strict(),
  z.object({ ...sidecarConfigFields, protocolVersion: z.literal(2), timedFrames: z.literal(true) }).strict()
])
export const sidecarStatusSchema = z.object({
  type: z.literal('status'), ...sessionIdentity,
  status: z.enum(['starting', 'loading', 'warming-up', 'ready', 'listening', 'processing', 'restarting', 'error', 'stopped', 'standby']),
  requestId: z.string().uuid().optional(),
  clock: z.object({ clientSendMs: z.number().finite(), serverReceiveMs: z.number().finite(),
    serverSendMs: z.number().finite() }).strict().optional(),
  metrics: z.object({
    source: audioSourceSchema, inferenceMs: z.number().finite().nonnegative().optional(),
    queueWaitMs: z.number().finite().nonnegative().optional(),
    queueDepth: samplePosition, droppedSamples: samplePosition
  }).strict().optional()
}).strict()
export const sidecarErrorSchema = z.object({
  type: z.literal('error'), code: z.string().min(1).max(80), message: z.string().min(1).max(300),
  recoverable: z.boolean(), sessionId: sessionIdentity.sessionId.nullable(),
  generation: samplePosition.nullable()
}).strict()
const transcriptEvent = {
  ...sessionIdentity, id: z.string().min(1).max(160), source: audioSourceSchema,
  text: z.string().max(8000), startMs: milliseconds, endMs: milliseconds, timing: transcriptTimingSchema.optional()
}
export const sidecarEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('partial'), ...transcriptEvent }).strict(),
  z.object({ type: z.literal('final'), ...transcriptEvent }).strict(),
  sidecarStatusSchema, sidecarErrorSchema
]).refine((event) => !('endMs' in event) || event.endMs >= event.startMs, {
  message: 'endMs must be at least startMs'
}).refine((event) => event.type !== 'error' || (event.sessionId === null) === (event.generation === null), {
  message: 'Error session identity must be complete or null'
})
const controlIdentity = { ...sessionIdentity, requestId: z.string().uuid() }
export const sidecarControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('clock-sync'), ...controlIdentity, clientSendMs: z.number().finite() }).strict(),
  z.object({ type: z.literal('clock-set'), ...controlIdentity, offsetMs: z.number().finite(),
    uncertaintyMs: z.number().finite().nonnegative() }).strict(),
  z.object({ type: z.literal('session-begin'), ...controlIdentity, nextSessionId: z.string().uuid(),
    language: z.string().min(1).max(32).nullable(), enabledSources: z.array(audioSourceSchema).min(1).max(2)
      .refine((sources) => new Set(sources).size === sources.length, 'Sources must be unique').meta({ uniqueItems: true }) }).strict(),
  z.object({ type: z.literal('session-end'), ...controlIdentity }).strict(),
  z.object({ type: z.literal('source-start'), ...controlIdentity, source: audioSourceSchema, startSample: samplePosition }).strict(),
  z.object({ type: z.literal('source-gap'), ...controlIdentity, source: audioSourceSchema, startSample: samplePosition, droppedSamples: samplePosition }).strict(),
  z.object({ type: z.literal('source-end'), ...controlIdentity, source: audioSourceSchema, paddedSamples: samplePosition.max(1599) }).strict(),
  ...(['pause', 'resume', 'stop', 'ping'] as const).map((type) => z.object({ type: z.literal(type), ...controlIdentity }).strict())
])
export const sidecarListeningSchema = z.object({
  protocolVersion: z.literal(1), port: z.number().int().min(1).max(65535), state: z.literal('listening')
}).strict()
export const fixtureCommandSchema = z.enum(['play', 'pause', 'stop'])
export const fixtureStatusSchema = z.enum(['idle', 'playing', 'paused', 'completed'])

export const captureFinishedSchema = z.object({
  error: z.string().max(300).nullable(), paddedSamples: z.number().int().min(0).max(1599)
}).strict()
