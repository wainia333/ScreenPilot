import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
for (const name of ['hdrcapture', 'inputhub', 'gifrecorder', 'longstitch', 'screenpilot']) {
  const args = ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '-p', name]
  if (name === 'screenpilot') args.push('capture_')
  const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
