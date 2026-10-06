import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
if (process.platform !== 'win32' || !npmCli) throw new Error('Use npm run build:portable on Windows.')
const run = args => {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['run', 'verify'])
run(['run', 'capture:verify'])
run(['exec', 'tauri', '--', 'build', '--no-bundle', '--config', JSON.stringify({ build: { beforeBuildCommand: 'npm run build:ui' } })])
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const folder = join(root, 'release', `ScreenPilot-${version}-single-exe`)
const original = join(root, 'src-tauri', 'target', 'release', 'screenpilot.exe')
if (!existsSync(original)) throw new Error('Portable application EXE was not built.')
mkdirSync(folder, { recursive: true })
const destination = join(folder, 'ScreenPilot.exe')
copyFileSync(original, destination)
const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex')
writeFileSync(join(root, 'release', 'portable-artifact.json'), JSON.stringify({ version, executable: destination, sha256, distribution: 'Single portable executable with native capture cores and React UI. Requires supported Windows and WebView2. Configuration/cache are created beside the EXE. System-vault credentials do not travel with EXE.' }, null, 2))
console.log(`Portable application: ${destination}`)
