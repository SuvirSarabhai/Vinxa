import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { app } from 'electron'
import type { TranscriptSegment } from '../../shared/contracts'
import type { MeetingStore } from '../db/repository'
import { managedFiles } from '../managed-files'
import { assertMeetingIdle } from '../delete-meeting'
import { resolveSidecarRuntime } from '../sidecar-manager'

export const turnsSchema = z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
  speaker: z.number().int().min(0).max(100) }).refine(v => v.endMs > v.startMs)).max(20000)
export function speakerAssignments(segments: TranscriptSegment[], turns: z.infer<typeof turnsSchema>) {
  const labels = new Map<number, string>()
  const assignments: { segmentId: string; label: string }[] = []
  for (const turn of [...turns].sort((a,b) => a.startMs-b.startMs)) {
    if (!labels.has(turn.speaker)) labels.set(turn.speaker, 'Remote ' + (labels.size + 1))
  }
  for (const segment of segments) {
    if (segment.source !== 'system' || segment.endMs <= segment.startMs) continue
    const scores = new Map<number, number>()
    for (const turn of turns) {
      const overlap = Math.max(0, Math.min(segment.endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs))
      scores.set(turn.speaker, (scores.get(turn.speaker) ?? 0) + overlap)
    }
    const ranked = [...scores].sort((a,b) => b[1]-a[1]), duration = segment.endMs-segment.startMs
    // Mixed/uncertain segments keep the channel fallback; don't guess identities.
    const first = ranked[0]
    if (first && first[1] >= duration * 0.6 && (ranked[1]?.[1] ?? 0) < duration * 0.25) {
      assignments.push({ segmentId: segment.id, label: labels.get(first[0])! })
    }
  }
  return assignments
}
export async function clusterMeeting(store: MeetingStore, id: string, signal?: AbortSignal): Promise<number> {
  assertMeetingIdle(store, id)
  const meeting = store.meeting(id), wav = meeting.systemAudioPath
  if (!wav) throw new Error('This meeting has no system audio. Microphone audio is not remotely clustered.')
  const files = await managedFiles(store.userData, id, [wav])
  if (!files.files.includes(wav)) throw new Error('Saved system WAV is missing.')
  const segmentation = process.env.VINXA_DIARIZATION_SEGMENTATION, embedding = process.env.VINXA_DIARIZATION_EMBEDDING
  if (!segmentation || !embedding || !existsSync(segmentation) || !existsSync(embedding)) {
    throw new Error('Configure local VINXA_DIARIZATION_SEGMENTATION and VINXA_DIARIZATION_EMBEDDING ONNX files before launching Vinxa. See docs/phase5.md.')
  }
  const runtime = resolveSidecarRuntime({ appPath: process.env.VINXA_SIDECAR_SOURCE || app.getAppPath(),
    resourcesPath: process.resourcesPath, packaged: app.isPackaged && !process.env.VINXA_SIDECAR_SOURCE }, process.env.VINXA_SIDECAR_PYTHON)
  const args = runtime.args.map(arg => arg === 'sidecar.server' ? 'sidecar.entrypoint' : arg).concat('--cluster')
  const output = await new Promise<string>((resolve,reject) => {
    execFile(runtime.command, args, { cwd: runtime.cwd, windowsHide: true, timeout: 600000, signal, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ...runtime.env, VINXA_DIARIZATION_WAV: wav, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } },
    (error,stdout) => error ? reject(new Error('Local clustering failed. Check optional sherpa-onnx installation, model compatibility, and one-hour limit. Channel labels were retained.')) : resolve(stdout))
  })
  const turns = turnsSchema.parse(JSON.parse(output))
  const assignments = speakerAssignments(store.transcript(id), turns)
  store.db.transaction(() => {
    store.db.prepare('DELETE FROM remote_speakers WHERE meetingId=?').run(id)
    const insert = store.db.prepare('INSERT INTO remote_speakers VALUES (?,?,?)')
    for (const item of assignments) insert.run(id, item.segmentId, item.label)
  })()
  return assignments.length
}
