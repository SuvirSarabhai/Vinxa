import { readFile } from 'node:fs/promises'
import { validateWav } from '../src/main/audio/wav-validation.ts'

try {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: node scripts/validate-wav.mjs test_recordings/mic.wav')
  console.log(JSON.stringify(validateWav(await readFile(path)), null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'WAV validation failed')
  process.exitCode = 1
}
