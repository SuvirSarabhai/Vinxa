import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConsentRecord } from '../shared/phase2'

// An append and a deletion can overlap while another session is awaiting consent.
let pending = Promise.resolve()
function edit(operation: () => Promise<void>): Promise<void> {
  const result = pending.then(operation)
  pending = result.catch(() => undefined)
  return result
}

export function saveConsent(root: string, record: ConsentRecord): Promise<void> {
  return edit(async () => {
    await mkdir(root, { recursive: true })
    await appendFile(join(root, 'consent-events.jsonl'), JSON.stringify(record) + '\n', 'utf8')
  })
}

export function removeConsent(root: string, id: string): Promise<void> {
  return edit(async () => {
    const path = join(root, 'consent-events.jsonl')
    const temporary = path + '.rewrite'
    await rm(temporary, { force: true })
    let original: string
    try { original = await readFile(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const kept = original.split('\n').filter(line => {
      try { return JSON.parse(line)?.sessionId !== id }
      catch { return true }
    }).join('\n')
    if (kept === original) return
    try {
      await writeFile(temporary, kept, { flag: 'wx', flush: true })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  })
}
