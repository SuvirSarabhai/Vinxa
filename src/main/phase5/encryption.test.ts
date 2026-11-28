import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRequestedEncryption, encryptionStatus } from './encryption'
import { powershell } from './windows'
vi.mock('./windows', () => ({ powershell: vi.fn() }))
const folders: string[] = []
afterEach(() => { vi.resetAllMocks(); for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true }) })
it('does not invoke encryption without an explicit saved request', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'vinxa-efs-')); folders.push(folder)
  await applyRequestedEncryption(folder)
  expect(powershell).not.toHaveBeenCalled()
})
it('preserves profile data and reports failure when EFS is unavailable', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'vinxa-efs-')); folders.push(folder)
  writeFileSync(join(folder, 'phase5-encryption-request.json'), '{"requested":true}')
  writeFileSync(join(folder, 'saved.wav'), 'original data')
  vi.mocked(powershell).mockRejectedValue(new Error('unsupported'))
  await expect(applyRequestedEncryption(folder)).rejects.toThrow('files were preserved')
  expect(existsSync(join(folder, 'saved.wav'))).toBe(true)
  expect(readFileSync(join(folder, 'saved.wav'), 'utf8')).toBe('original data')
  expect(existsSync(join(folder, 'phase5-encryption-request.json'))).toBe(false)
  expect(await encryptionStatus(folder)).not.toContain('EFS verified')
})
