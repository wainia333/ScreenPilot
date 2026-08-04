import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const referenceRoot = 'E:\\我的文档\\Kivio-modificated'
const executionSpec = resolve(root, '..', 'ScreenPilot-大模型执行规范.md')
const exactFiles = new Map([
  ['src/vendor/kivio-screenshot/Vision.tsx', ['src/Vision.tsx', '72F72EC9E40FD3D00A879430A46DF6D72919F3C47B7BD202DC6160395E761C02']],
  ['src/vendor/kivio-screenshot/api/tauri.ts', ['src/api/tauri.ts', 'D99BF577F7626CC9D18B3B9916F74BCD174DED41559967D94450E3AEC348EFF8']],
  ['src/vendor/kivio-screenshot/settings/i18n.ts', ['src/settings/i18n.ts', '589F655107B59FDCC40B6D9E7D08740B3B17564804E96B4D6BA500DFF6E1DA3C']],
  ['src/vendor/kivio-screenshot/utils/clipboard.ts', ['src/utils/clipboard.ts', '3C0BDA8922C7597460BCDC6CF6D560802BD3C260B2BD77E5A386798BE9D42045']],
  ['src/vendor/kivio-screenshot/index.css', ['src/index.css', 'A88745C3A01A960A3CB77E7F9DE35071D04BE7A25C00BB440F1E3C6D2A401029']],
  ['public/emojione--leaf-fluttering-in-wind.svg', ['public/emojione--leaf-fluttering-in-wind.svg', '90400CD289CAF414A671400371A93511AAEA82882C0CF7C3F7320E15816D623E']],
  ['src-tauri/src/vision.rs', ['src-tauri/src/vision.rs', '8C1109E437693B927E3CD87CD2103EF740E3F311766F847D7661B7AE9B523717']],
  ['src-tauri/src/native_freeze.rs', ['src-tauri/src/native_freeze.rs', 'CFDC421F36214D5340272C768A21A40DB738477753C5B83DB47AB686E6C2DB82']],
  ['src-tauri/src/screenshot.rs', ['src-tauri/src/screenshot.rs', 'A7768399F178D2FC5FA1361080E134358EEBC1C3B78551AA9F065F735184EA43']],
  ['src-tauri/src/windows.rs', ['src-tauri/src/windows.rs', 'F25A5100D024E40C4579B780BAEEA3FEA7EA47E17C9220601D83C19BB31EC1B6']],
])
const authorizedPatchedFiles = new Map([
  ['src/vendor/kivio-screenshot/Vision.tsx', 'A068D44890AF085AF6EE7661BEABA47641508FEECBEBC3A054514B65F6EB15E6'],
  ['src/vendor/kivio-screenshot/api/tauri.ts', '3D47CE11CF1EC20057551AFFE97ABA94B388B3880596EC859ACF7058DB5916AF'],
])
const ignoredDirectories = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
])
const ignoredFiles = new Set([
  '上次对话.md',
])

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

function files(directory) {
  const found = []
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue
    const file = join(directory, entry)
    if (statSync(file).isDirectory()) found.push(...files(file))
    else found.push(file)
  }
  return found
}

const failures = []
for (const [target, [source, expected]] of exactFiles) {
  const targetFile = join(root, target)
  if (!existsSync(targetFile)) {
    failures.push(`缺少原样副本：${target}`)
    continue
  }
  const targetHash = hash(targetFile)
  const authorizedHash = authorizedPatchedFiles.get(target)
  if (targetHash !== (authorizedHash ?? expected)) failures.push(`原样副本哈希不符：${target}`)
  const sourceFile = join(referenceRoot, source)
  if (!authorizedHash && existsSync(sourceFile) && hash(sourceFile) !== targetHash) {
    failures.push(`原样副本与参考源不一致：${target}`)
  }
}

const projectFiles = files(root)
const markdown = projectFiles
  .filter((file) => extname(file).toLowerCase() === '.md')
  .map((file) => relative(root, file).replaceAll('\\', '/'))
  .filter((file) => !ignoredFiles.has(file))
if (markdown.length !== 0) {
  failures.push(`Markdown 门禁不符：${markdown.join(', ')}`)
}
if (!existsSync(executionSpec)) failures.push(`缺少项目外执行规范：${executionSpec}`)

for (const obsolete of [
  'src/features/vision/vision-page.tsx',
  'src/features/vision/geometry.ts',
  'src/features/vision/machine.ts',
  'src-tauri/src/platform/windows/capture.rs',
  'src-tauri/src/platform/windows/window_shape.rs',
]) {
  if (existsSync(join(root, obsolete))) failures.push(`旧截图实现仍存在：${obsolete}`)
}

const appSource = readFileSync(join(root, 'src/app/app.tsx'), 'utf8')
if (!appSource.includes("import('../features/vision/reference-vision')")) {
  failures.push('生产前端未接入原样 Vision')
}
const rustSource = readFileSync(join(root, 'src-tauri/src/application/commands/vision.rs'), 'utf8')
for (const call of ['crate::native_freeze::show', 'crate::native_freeze::capture_active_region_to_png', 'crate::vision::list_windows']) {
  if (!rustSource.includes(call)) failures.push(`生产后端未接入原样截图核心：${call}`)
}

if (failures.length > 0) {
  failures.forEach((failure) => console.error(failure))
  process.exitCode = 1
} else {
  console.log('项目门禁通过：十份截图模式副本哈希一致，旧截图路径不存在，项目外规范文件存在。')
}
