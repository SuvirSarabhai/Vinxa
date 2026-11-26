// Export from authoritative Zod schemas; --check verifies the tracked artifact.
const fs = require('node:fs')
const path = require('node:path')
const { stripTypeScriptTypes } = require('node:module')
const { z } = require('zod')
const schemas = require('../src/shared/schemas.ts')
const { sourceIds } = require('../src/shared/contracts.ts')
async function main() {
  // PCM uses parameter properties, which require Node's transform mode.
  const pcmSource = fs.readFileSync(path.join(__dirname, '../src/shared/pcm.ts'), 'utf8')
  const pcmModule = stripTypeScriptTypes(pcmSource, { mode: 'transform' })
  const { pcmFormat } = await import('data:text/javascript;base64,' + Buffer.from(pcmModule).toString('base64'))
  const entries = {
    config: schemas.sidecarConfigSchema, event: schemas.sidecarEventSchema,
    control: schemas.sidecarControlSchema, frameMetadata: schemas.audioFrameMetadataSchema,
    listening: schemas.sidecarListeningSchema
  }
  const output = JSON.stringify({
    constants: { ...pcmFormat, sourceIds },
    ...Object.fromEntries(Object.entries(entries).map(([name, schema]) => [name, z.toJSONSchema(schema)]))
  }, null, 2) + '\n'
  const target = path.join(__dirname, '../sidecar/wire-schema.json')
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) {
      process.stderr.write('Sidecar wire schema is stale; run node scripts/export-sidecar-schema.cjs\n')
      process.exitCode = 1
    }
  } else fs.writeFileSync(target, output)
}
main().catch(() => { process.stderr.write('Sidecar schema export failed\n'); process.exitCode = 1 })
