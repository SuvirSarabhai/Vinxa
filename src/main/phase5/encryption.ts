import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { powershell } from './windows'

const requestName = 'phase5-encryption-request.json'
export function requestEncryption(root: string): void {
  if (process.platform !== 'win32') throw new Error('Windows EFS is required.')
  writeFileSync(join(root, requestName), JSON.stringify({ requested: true }), { flag: 'w' })
}
const inspect = `
$ErrorActionPreference='Stop'
$root=Get-Item -LiteralPath $env:VINXA_EFS_ROOT -Force
if($root.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked profile is unsupported'}
$items=@($root)+@(Get-ChildItem -LiteralPath $root.FullName -Force -Recurse -ErrorAction Stop)
if(@($items|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Linked files are unsupported'}
`
export async function encryptionStatus(root: string): Promise<string> {
  if (process.platform !== 'win32') return 'Windows EFS is unavailable on this platform.'
  if (existsSync(join(root, requestName))) return 'Encryption requested. Quit and reopen Vinxa to apply it.'
  try {
    const result = await powershell(inspect + `
$missing=@($items|Where-Object {-not ($_.Attributes -band [IO.FileAttributes]::Encrypted)}).Count
if($missing -eq 0){'verified'}else{'unprotected'}
`, { VINXA_EFS_ROOT: root })
    return result === 'verified' ? 'Windows EFS verified for the profile and its current files. Exported copies are outside this protection.' : 'Profile is not fully EFS encrypted.'
  } catch { return 'EFS status could not be verified. No encryption claim is made.' }
}
/** Runs before SQLite, speech and capture open any profile files. */
export async function applyRequestedEncryption(root: string): Promise<void> {
  const marker = join(root, requestName)
  if (!existsSync(marker)) return
  if (JSON.parse(readFileSync(marker, 'utf8')).requested !== true) throw new Error('Invalid encryption request.')
  try {
    await powershell(inspect + `
# Directories first so all future SQLite journals, WAVs and metadata inherit EFS.
foreach($item in $items|Where-Object {$_.PSIsContainer}){& "$env:SystemRoot\\System32\\cipher.exe" /E /A /H $item.FullName | Out-Null; if($LASTEXITCODE -ne 0){throw 'EFS unsupported'}}
foreach($item in $items|Where-Object {-not $_.PSIsContainer}){[IO.File]::Encrypt($item.FullName)}
$check=@(Get-Item -LiteralPath $root.FullName -Force)+@(Get-ChildItem -LiteralPath $root.FullName -Force -Recurse)
if(@($check|Where-Object {-not ($_.Attributes -band [IO.FileAttributes]::Encrypted)}).Count){throw 'EFS verification failed'}
`, { VINXA_EFS_ROOT: root }, 120000)
    unlinkSync(marker)
  } catch {
    // Partial EFS conversion is readable by the same Windows account. Preserve
    // every file, stop automatic retries, and never label a partial run secure.
    unlinkSync(marker)
    throw new Error('Windows could not fully encrypt the Vinxa profile. Your files were preserved. EFS may be unsupported by your Windows edition, drive or permissions; some files may already be encrypted. Back up your EFS certificate using cipher /x before moving or reinstalling Windows.')
  }
}
