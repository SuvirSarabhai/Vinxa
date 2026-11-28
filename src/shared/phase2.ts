import { z } from 'zod'
import { recordingConfigSchema, recordingStateSchema, transcriptSegmentSchema } from './schemas'
import type { RecordingConfig, RecordingState, TranscriptSegment, AudioSourceName, AudioFrameMetadata } from './contracts'

export const recordingEngineSchema = z.object({ ready: z.boolean(), message: z.string() }).strict()
export type RecordingEngine = z.infer<typeof recordingEngineSchema>

export const phase2Channels = {
  command: 'phase2:command', snapshot: 'phase2:snapshot', changed: 'phase2:changed', overlayDrag: 'phase2:overlay-drag'
} as const

export const overlayDragSchema = z.enum(['start', 'move', 'end'])
export type OverlayDragPhase = z.infer<typeof overlayDragSchema>

const acceleratorSchema = z.string().trim()
  .regex(/^Ctrl\+Alt\+[A-Z0-9]$/i, 'Use Ctrl+Alt plus one letter or number, for example Ctrl+Alt+S')
  .transform((value) => `Ctrl+Alt+${value.slice(-1).toUpperCase()}`)

export const hotkeysSchema = z.object({
  start: acceleratorSchema, pause: acceleratorSchema, stop: acceleratorSchema
}).strict().refine((value) => new Set(Object.values(value)).size === 3, {
  message: 'Each action needs a different shortcut'
})

export const defaultHotkeys = {
  start: 'Ctrl+Alt+S', pause: 'Ctrl+Alt+P', stop: 'Ctrl+Alt+X'
}

export const phase2CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('confirm'), config: recordingConfigSchema, consent: z.literal(true) }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('pause-resume') }).strict(),
  z.object({ type: z.literal('select-microphone'), deviceId: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('show-overlay') }).strict(),
  z.object({ type: z.literal('open-library') }).strict(),
  z.object({ type: z.literal('collapse') }).strict(),
  z.object({ type: z.literal('opacity'), value: z.number().min(0.5).max(1) }).strict(),
  z.object({ type: z.literal('copy-lines') }).strict(),
  z.object({ type: z.literal('copy-announcement') }).strict(),
  z.object({ type: z.literal('hotkeys'), value: hotkeysSchema }).strict()
])

export const pauseGapSchema = z.object({
  startMs: z.number().nonnegative(), endMs: z.number().nonnegative().nullable()
}).refine((gap) => gap.endMs === null || gap.endMs >= gap.startMs)

export const sessionSnapshotSchema = z.object({
  state: recordingStateSchema,
  mode: z.enum(['demo', 'local']),
  busy: z.boolean(),
  consentRequest: z.number().int().nonnegative(),
  config: recordingConfigSchema,
  segments: z.array(transcriptSegmentSchema),
  sessionId: z.string().nullable(),
  startedAtMs: z.number().nonnegative().nullable().optional(),
  endedAtMs: z.number().nonnegative().nullable().optional(),
  error: z.string().nullable(),
  notice: z.string(),
  pauses: z.array(pauseGapSchema),
  levels: z.object({
    mic: z.number().min(0).max(1).nullable(), system: z.number().min(0).max(1).nullable()
  })
})

export const phase2SnapshotSchema = sessionSnapshotSchema.extend({
  revision: z.number().int().nonnegative(),
  ready: z.boolean(),
  hotkeys: hotkeysSchema,
  activeHotkeys: z.array(z.string()),
  hotkeyErrors: z.array(z.string()),
  collapsed: z.boolean(),
  opacity: z.number().min(0.5).max(1),
  engine: recordingEngineSchema
})

export type Phase2Command = z.infer<typeof phase2CommandSchema>
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>
export type Phase2Snapshot = z.infer<typeof phase2SnapshotSchema>
export type Hotkeys = z.infer<typeof hotkeysSchema>
export type HotkeyAction = keyof Hotkeys

export interface Phase2Api {
  dragOverlay(phase: OverlayDragPhase): void
  command(command: Phase2Command): Promise<void>
  snapshot(): Promise<Phase2Snapshot>
  onChange(listener: (snapshot: Phase2Snapshot) => void): () => void
}

export interface BackendEvents {
  audioFrame?(source: AudioSourceName, pcm: Uint8Array, metadata: AudioFrameMetadata): Promise<void>
  sourceEnded?(source: AudioSourceName, padding: number): Promise<void>
  processing?(): void
  transcript(segment: TranscriptSegment): void
  levels(mic: number | null, system: number | null): void
  notice(message: string): void
  failure(message?: string): void
  discardPartials?(): void
}

export interface RecordingBackend {
  mode: 'demo' | 'local'
  start(config: RecordingConfig, sessionId: string, events: BackendEvents, sessionStartMs?: number): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  selectMicrophone?(deviceId:string): Promise<void>
  stop(): Promise<void>
  bindOwner?(owner: { getState(): RecordingState; hasConsent(sessionId: string): boolean }): void
  onEngine?(listener: (engine: RecordingEngine) => void): () => void
  dispose?(): void
}

export const consentStatementVersion = 'phase2-v1'
export const announcement = 'I would like to use Vinxa to record microphone and meeting audio locally for a transcript and meeting notes. Please confirm your consent.'
export const demoAnnouncement = 'I am demonstrating Vinxa using a written sample transcript. No microphone or meeting audio is being recorded.'

export interface ConsentRecord {
  sessionId: string
  confirmedAtUtc: string
  statementVersion: string
  mode: 'demo' | 'local'
  microphoneEnabled: boolean
  systemAudioEnabled: boolean
  announcementCopied: boolean
}
