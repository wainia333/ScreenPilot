import { existsSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export const vendorProductionDirectory = 'src/vendor/kivio-screenshot'

function projectPath(projectRoot, file) {
  return relative(projectRoot, file).split(sep).join('/')
}

function walk(projectRoot, directory) {
  const discovered = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      discovered.push(...walk(projectRoot, file))
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(?:css|ts|tsx)$/u.test(entry.name) || entry.name.includes('.test.')) continue
    discovered.push(projectPath(projectRoot, file))
  }
  return discovered
}

export function discoverVendorProductionFiles(projectRoot) {
  const directory = resolve(projectRoot, vendorProductionDirectory)
  if (!existsSync(directory)) throw new Error(`缺少受控 vendor 目录：${vendorProductionDirectory}`)
  return walk(projectRoot, directory).sort()
}
