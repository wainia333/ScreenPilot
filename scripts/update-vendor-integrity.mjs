import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { discoverVendorProductionFiles } from './vendor-production-files.mjs'

const confirmation = '--accept-reviewed-changes'
if (!process.argv.includes(confirmation)) {
  console.error(`拒绝更新：请先审查完整 vendor 差异，再显式传入 ${confirmation}`)
  process.exit(1)
}
if (process.env.CI === 'true') {
  console.error('拒绝在 CI 中自动更新 vendor 完整性基线')
  process.exit(1)
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifestPath = resolve(root, 'scripts/vendor-integrity.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (
  manifest.version !== 1
  || manifest.algorithm !== 'sha256'
  || manifest.normalization !== 'utf8-lf'
  || typeof manifest.files !== 'object'
  || manifest.files === null
  || Array.isArray(manifest.files)
) {
  throw new Error('vendor 完整性清单格式无效')
}

function hash(file) {
  const normalizedText = readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n')
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex').toUpperCase()
}

const changes = []
const trackedPaths = Object.keys(manifest.files)
for (const [path, expected] of Object.entries(manifest.files)) {
  if (typeof expected !== 'string' || !/^[A-F0-9]{64}$/u.test(expected)) {
    throw new Error(`vendor 完整性清单哈希无效：${path}`)
  }
}
const trackedPathSet = new Set(trackedPaths)
const newPaths = discoverVendorProductionFiles(root).filter(path => !trackedPathSet.has(path))
for (const path of [...trackedPaths, ...newPaths]) {
  if (isAbsolute(path)) throw new Error(`完整性清单不得使用绝对路径：${path}`)
  const file = resolve(root, path)
  const relativePath = relative(root, file)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`完整性清单路径越出项目根目录：${path}`)
  }
  if (!existsSync(file)) throw new Error(`缺少受控 vendor 文件：${path}`)
  const added = !Object.hasOwn(manifest.files, path)
  const previous = manifest.files[path]
  const next = hash(file)
  if (previous !== next) changes.push({ path, previous, next, added })
  manifest.files[path] = next
}

if (changes.length === 0) {
  console.log('vendor 完整性基线无需更新。')
  process.exit(0)
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
for (const change of changes) {
  console.log(`${change.path}\n  ${change.added ? '(not listed)' : change.previous}\n  -> ${change.next}`)
}
console.log('vendor 完整性基线已更新。提交前必须审查受控文件及 scripts/vendor-integrity.json 的完整差异。')
