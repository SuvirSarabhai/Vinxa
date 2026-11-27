const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const python = process.env.VINXA_SIDECAR_PYTHON || join(root, '.venv', 'Scripts', 'python.exe')
if (!existsSync(python)) {
  console.error('Create .venv and install sidecar/requirements-package.txt before packaging.')
  process.exitCode = 1
} else {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const result = spawnSync(python, ['-m', 'sidecar.package_runtime', ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true, shell: false
  })
  if (result.error) console.error('The Python packaging process could not start.')
  process.exitCode = result.status ?? 1
}
