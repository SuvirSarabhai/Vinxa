import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import type { SidecarStatus } from '../shared/contracts'
import { SidecarManager, resolveSidecarRuntime } from './sidecar-manager'

it.runIf(process.env.VINXA_RUN_SIDECAR_SMOKE === '1')('reuses a real warmed model for two timed sessions and rewarms after restart', async () => {
  const statuses: SidecarStatus[] = []
  const errors: unknown[] = []
  const runtime = resolveSidecarRuntime({ appPath: resolve('.'), resourcesPath: resolve('resources'), packaged: false })
  const manager = new SidecarManager({ runtime, keepWarm: true, protocolVersion: 2,
    onTranscript: () => {}, onStatus: (event) => statuses.push(event), onError: (event) => errors.push(event),
    healthMs: 1000, maxRestarts: 1, backoffMs: 50 })
  try {
    await manager.prewarm()
    const firstChild = (manager as unknown as { child: ChildProcess }).child
    for (let session = 0; session < 2; session++) {
      await manager.start({ sessionId: randomUUID(), meetingId: 'timed-silence', model: 'base.en',
        language: 'en', enabledSources: ['mic', 'system'] })
      expect((manager as unknown as { child: ChildProcess }).child).toBe(firstChild)
      for (let index = 0; index < 3; index++) {
        for (const source of ['mic', 'system'] as const) manager.sendFrame(source, new Uint8Array(3200), {
          sequence: index, startSample: index * 1600, captureTimeMs: performance.now() - 100,
          captureErrorMs: 1, sampleCount: 1600, captureKind: 'replay'
        })
        await delay(100)
      }
      await manager.sourceEnd('mic')
      await manager.sourceEnd('system')
      await manager.endSession()
    }
    expect(statuses.filter((event) => event.status === 'loading' && !event.requestId)).toHaveLength(1)
    expect(statuses.filter((event) => event.status === 'warming-up' && !event.requestId)).toHaveLength(1)
    expect(errors).toHaveLength(0)
    firstChild.kill()
    const deadline = performance.now() + 60000
    while (!statuses.some((event) => event.generation === 1 && event.status === 'ready')) {
      if (performance.now() > deadline) throw new Error('Persistent sidecar restart timed out')
      await delay(50)
    }
    expect(statuses.filter((event) => event.status === 'loading' && !event.requestId)).toHaveLength(2)
    expect(statuses.filter((event) => event.status === 'warming-up' && !event.requestId)).toHaveLength(2)
  } finally { await manager.stop() }
}, 120000)
