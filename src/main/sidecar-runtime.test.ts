import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ paths: new Set<string>() }))
vi.mock('node:fs', () => ({ existsSync: (path: string) => fake.paths.has(path), readFileSync: vi.fn() }))

import { resolveSidecarRuntime } from './sidecar-manager'

const resources = resolve('runtime-fixture')
const executable = join(resources, 'sidecar', process.platform === 'win32' ? 'vinxa-sidecar.exe' : 'vinxa-sidecar')
const modelPath = join(resources, 'sidecar', 'models', 'base.en')
beforeEach(() => {
  fake.paths.clear()
  vi.stubEnv('VINXA_SPEECH_MODEL', 'base.en')
  vi.stubEnv('VINXA_SPEECH_MODEL_PATH', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('bundled speech runtime resolution', () => {
  it('uses the frozen executable and its model without an installed interpreter', () => {
    fake.paths.add(executable)
    fake.paths.add(join(modelPath, 'model.bin'))
    const runtime = resolveSidecarRuntime({ appPath: resolve('app.asar'), resourcesPath: resources, packaged: true })
    expect(runtime).toMatchObject({ command: executable, args: [], env: {
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', VINXA_SPEECH_MODEL_PATH: modelPath
    } })
  })

  it('preserves an explicit model-path override', () => {
    fake.paths.add(executable)
    fake.paths.add(join(modelPath, 'model.bin'))
    vi.stubEnv('VINXA_SPEECH_MODEL_PATH', resolve('external-model'))
    const runtime = resolveSidecarRuntime({ appPath: resolve('app.asar'), resourcesPath: resources, packaged: true })
    expect(runtime.env).not.toHaveProperty('VINXA_SPEECH_MODEL_PATH')
  })
})
