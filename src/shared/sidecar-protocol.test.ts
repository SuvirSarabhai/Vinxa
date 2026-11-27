import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { audioFrameMetadataSchema, sidecarConfigSchema, sidecarControlSchema,
  sidecarEventSchema, sidecarListeningSchema } from './schemas'

const fixtures = JSON.parse(readFileSync('sidecar/fixtures/protocol.json', 'utf8'))
const schemas = { config: sidecarConfigSchema, control: sidecarControlSchema,
  event: sidecarEventSchema, frameMetadata: audioFrameMetadataSchema, listening: sidecarListeningSchema }
const testToken = randomBytes(32).toString('hex')

describe('approved sidecar wire contract', () => {
  for (const test of fixtures.cases) {
    it(test.name, () => {
      const payload = { ...fixtures.bases[test.base], ...test.patch }
      if (payload.token === '$TEST_TOKEN') payload.token = testToken
      if (payload.token === '$TEST_TOKEN_WITH_NEWLINE') payload.token = testToken + '\n'
      for (const key of test.omit ?? []) delete payload[key]
      expect(schemas[test.kind as keyof typeof schemas].safeParse(payload).success).toBe(test.valid)
    })
  }
  it('keeps the generated Python wire schema synchronized with Zod and PCM constants', () => {
    expect(() => execFileSync(process.execPath, ['scripts/export-sidecar-schema.cjs', '--check'],
      { stdio: 'pipe' })).not.toThrow()
  })
  it('rejects non-finite metrics', () => {
    expect(sidecarEventSchema.safeParse({ ...fixtures.bases.status,
      metrics: { source: 'mic', queueDepth: 0, droppedSamples: 0, inferenceMs: Infinity } }).success).toBe(false)
  })
})
