import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import type { SidecarStatus, TranscriptSegment } from '../shared/contracts'
import { resolveSidecarRuntime, SidecarManager } from './sidecar-manager'

it.runIf(process.env.VINXA_RUN_SIDECAR_SMOKE === '1')('runs actual Python/WebSocket warm-up, crash recovery and silent dual capture', async () => {
  const statuses: SidecarStatus[] = [], transcripts: TranscriptSegment[] = []
  const runtime = resolveSidecarRuntime({ appPath: resolve('.'), resourcesPath: resolve('resources'), packaged: false })
  const manager = new SidecarManager({ runtime, onTranscript: (event) => transcripts.push(event),
    onStatus: (event) => statuses.push(event), onError: () => {}, healthMs: 500, requestMs: 5000,
    readyMs: 60000, maxRestarts: 1, backoffMs: 50 })
  try {
    await manager.start({ sessionId: randomUUID(), meetingId: 'local-silence-smoke', model: 'base.en',
      language: 'en', enabledSources: ['mic', 'system'] })
    expect(statuses.map((event) => event.status)).toEqual(expect.arrayContaining(['loading', 'warming-up', 'ready']))
    const child = (manager as unknown as { child: ChildProcess }).child
    child.kill() // real owned direct model process, not a venv redirector
    const deadline = Date.now() + 60000
    while (!statuses.some((event) => event.generation === 1 && event.status === 'ready')) {
      if (Date.now() > deadline) throw new Error('Actual restart did not reach readiness')
      await delay(50)
    }
    for (let index = 0; index < 20; index++) {
      for (const source of ['mic', 'system'] as const) manager.sendFrame(source, new Uint8Array(3200), { startSample: index * 1600 })
      await delay(100)
    }
    await manager.sourceEnd('mic')
    await manager.sourceEnd('system')
    await manager.stop()
    expect(transcripts).toHaveLength(0)
    expect(manager.ready).toBe(false)
  } finally { await manager.stop() }
}, 120000)
