import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const fail = message => { throw new Error(message) }
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
if (JSON.stringify(tauri).match(/capture:prepare|python|pyside/iu) || tauri.bundle?.externalBin?.length) fail('External capture runtime remains in Tauri configuration')
const tree = execFileSync('cargo', ['tree', '--manifest-path', join(root, 'src-tauri/Cargo.toml'), '--locked', '--prefix', 'none'], { encoding: 'utf8' })
if (/^(pyo3|pyside|qmetaobject|cxx-qt)\b/imu.test(tree)) fail('Python/Qt is linked into the dependency graph')
for (const name of ['hdrcapture', 'inputhub', 'longstitch', 'gifrecorder']) {
  if (!tree.includes(`${name} v`)) fail(`Missing native capture core: ${name}`)
  const dir = join(root, 'src-tauri/crates', name)
  if (readdirSync(join(dir, 'src')).includes('python.rs')) fail(`Python binding remains: ${name}`)
  if (/pyo3\s*=|extension-module/u.test(readFileSync(join(dir, 'Cargo.toml'), 'utf8'))) fail(`Python dependency remains: ${name}`)
}
for (const path of ['src/features/capture/editor', 'src-tauri/src/application']) {
  const dir = join(root, path)
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx|rs)$/u.test(file) || (path.endsWith('application') && !file.startsWith('capture_'))) continue
    const source = readFileSync(join(dir, file), 'utf8')
    if (/python\.exe|PySide|pyo3|Command::new/iu.test(source)) fail(`External runtime launch in ${path}/${file}`)
  }
}
const manifest = JSON.parse(readFileSync(join(root, 'src-tauri/crates/capture-core-integrity.json'), 'utf8'))
for (const entry of manifest.files) {
  const normalized = readFileSync(join(root, 'src-tauri/crates', entry.path), 'utf8').replace(/\r\n?/gu, '\n')
  if (createHash('sha256').update(normalized).digest('hex') !== entry.sha256) fail(`Capture core integrity mismatch: ${entry.path}`)
}
console.log('Capture runtime: Tauri/Rust/React; four native capture cores verified; no Python/Qt runtime or sidecar.')
