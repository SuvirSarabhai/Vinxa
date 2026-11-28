import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { speechTuningSchema } from '../../shared/phase5'
import type { z } from 'zod'
const filename = 'phase5-speech.json'
export function speechTuning(root: string) {
  const path = join(root, filename)
  const defaults = {
    language: 'en', model: 'base.en', vadThreshold: 0.5, vadRelease: 0.35
  }
  if (!existsSync(path)) return speechTuningSchema.parse(defaults)
  try { return speechTuningSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { return speechTuningSchema.parse(defaults) }
}
export function saveSpeechTuning(root: string, input: z.input<typeof speechTuningSchema>): void {
  const value = speechTuningSchema.parse(input)
  if (value.language !== 'en' && value.model.endsWith('.en')) throw new Error('Hindi requires the multilingual small model.')
  const path = join(root, filename), temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}
export function applySpeechTuning(root: string): void {
  if (!existsSync(join(root, filename))) return
  const v = speechTuning(root)
  const defaults = { VINXA_SPEECH_MODEL: v.model, VINXA_SPEECH_LANGUAGE: v.language,
    VINXA_VAD_THRESHOLD: String(v.vadThreshold), VINXA_VAD_RELEASE: String(v.vadRelease) }
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value
}
