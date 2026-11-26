import type { z } from 'zod'
import type {
  audioSourceSchema, fixtureCommandSchema, fixtureStatusSchema, meetingInsightsSchema,
  recordingConfigSchema, recordingStateSchema, sidecarConfigSchema, sidecarEventSchema,
  transcriptSegmentSchema
} from './schemas'

export type AudioSourceName = z.infer<typeof audioSourceSchema>
export type RecordingState = z.infer<typeof recordingStateSchema>
export type RecordingConfig = z.infer<typeof recordingConfigSchema>
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>
export type MeetingInsights = z.infer<typeof meetingInsightsSchema>
export type SidecarConfig = z.infer<typeof sidecarConfigSchema>
export type SidecarEvent = z.infer<typeof sidecarEventSchema>
export type FixtureCommand = z.infer<typeof fixtureCommandSchema>
export type FixtureStatus = z.infer<typeof fixtureStatusSchema>

export interface AudioSource {
  start(config: RecordingConfig, onFrame: (source: AudioSourceName, pcm: Uint8Array) => void): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}

export interface InsightsProvider {
  generate(segments: TranscriptSegment[]): Promise<MeetingInsights>
}

export interface DesktopApi {
  fixtureCommand(command: FixtureCommand): Promise<void>
  onTranscript(listener: (segment: TranscriptSegment) => void): () => void
  onFixtureStatus(listener: (status: FixtureStatus) => void): () => void
}

export const sourceIds = { mic: 0, system: 1 } as const

export interface CaptureBridge {
  ready(): Promise<void>
  frame(frame: ArrayBuffer): Promise<void>
  finished(result: { error: string | null; paddedSamples: number }): Promise<void>
  onStop(listener: () => void): () => void
}
