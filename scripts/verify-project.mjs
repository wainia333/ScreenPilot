import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { discoverVendorProductionFiles } from './vendor-production-files.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const integrityManifestPath = resolve(root, 'scripts/vendor-integrity.json')

function hash(file) {
  const normalizedText = readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n')
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex').toUpperCase()
}

function projectFile(path) {
  if (isAbsolute(path)) throw new Error(`完整性清单不得使用绝对路径：${path}`)
  const resolved = resolve(root, path)
  const relativePath = relative(root, resolved)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`完整性清单路径越出项目根目录：${path}`)
  }
  return resolved
}

function readIntegrityManifest() {
  if (!existsSync(integrityManifestPath)) throw new Error('缺少仓库内 vendor 完整性清单：scripts/vendor-integrity.json')
  const manifest = JSON.parse(readFileSync(integrityManifestPath, 'utf8'))
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
  return manifest.files
}

const failures = []
try {
  const lockedFiles = readIntegrityManifest()
  const lockedFileNames = new Set(Object.keys(lockedFiles))
  for (const target of discoverVendorProductionFiles(root)) {
    if (!lockedFileNames.has(target)) failures.push(`vendor 生产文件未纳入完整性清单：${target}`)
  }
  for (const [target, expected] of Object.entries(lockedFiles)) {
    if (typeof expected !== 'string' || !/^[A-F0-9]{64}$/u.test(expected)) {
      failures.push(`vendor 完整性清单哈希无效：${target}`)
      continue
    }
    let targetFile
    try {
      targetFile = projectFile(target)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
      continue
    }
    if (!existsSync(targetFile)) {
      failures.push(`缺少受控 vendor 文件：${target}`)
      continue
    }
    if (hash(targetFile) !== expected) failures.push(`受控 vendor 文件哈希不符：${target}`)
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
}

for (const obsolete of [
  'src/features/vision/vision-page.tsx',
  'src/features/vision/geometry.ts',
  'src/features/vision/machine.ts',
  'src-tauri/src/platform/windows/capture.rs',
  'src-tauri/src/platform/windows/window_shape.rs',
]) {
  if (existsSync(resolve(root, obsolete))) failures.push(`旧截图实现仍存在：${obsolete}`)
}

const appSource = readFileSync(resolve(root, 'src/app/app.tsx'), 'utf8')
if (!appSource.includes("import('../features/vision/reference-vision')")) {
  failures.push('生产前端未接入受控 Vision 适配层')
}
const rustSource = readFileSync(resolve(root, 'src-tauri/src/application/commands/vision.rs'), 'utf8')
for (const call of ['crate::native_freeze::show', 'crate::native_freeze::capture_active_region_to_png', 'crate::vision::list_windows']) {
  if (!rustSource.includes(call)) failures.push(`生产后端未接入受控截图核心：${call}`)
}
const lifecycleSource = readFileSync(resolve(root, 'src-tauri/src/application/lifecycle.rs'), 'utf8')
const visionSource = readFileSync(resolve(root, 'src/vendor/kivio-screenshot/Vision.tsx'), 'utf8')
const visionAdapterSource = readFileSync(resolve(root, 'src/features/vision/reference-vision.tsx'), 'utf8')
const tauriConfig = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const contentSecurityPolicy = tauriConfig?.app?.security?.csp
if (typeof contentSecurityPolicy !== 'string' || !contentSecurityPolicy.includes("media-src 'self' data: blob:")) {
  failures.push('Tauri CSP 未允许 OCR 朗读使用 data/blob 音频源')
}
const promptBarStart = visionSource.indexOf('{showBar &&')
const promptBarEnd = visionSource.indexOf('{showTranslateCard &&', promptBarStart)
const promptBarBody = promptBarStart >= 0 && promptBarEnd > promptBarStart
  ? visionSource.slice(promptBarStart, promptBarEnd)
  : ''
if (
  lifecycleSource.includes('VISION_FOCUS_REFRESH')
  || lifecycleSource.includes('refresh_vision_compositor')
  || rustSource.includes('vision_refresh_compositor')
  || visionSource.includes('visionRefreshCompositor')
) {
  failures.push('Vision 焦点路径仍在强制刷新透明 WebView2 合成表面')
}
if (
  !visionSource.includes('shouldPromoteVisionBarLayer')
  || !promptBarBody.includes("willChange: barMotionActive ? 'transform, opacity' : undefined")
  || promptBarBody.includes("willChange: 'transform, opacity'")
) {
  failures.push('Vision 静止输入条仍被永久提升为独立合成层')
}
const translateCardStart = visionSource.indexOf('{showTranslateCard &&')
const translateCardBody = translateCardStart >= 0 ? visionSource.slice(translateCardStart) : ''
if (
  visionSource.includes('translateCardHeight')
  || visionSource.includes('measureTranslateCardHeight')
  || !visionSource.includes('shouldReactOwnVisionFloatingResize(mode)')
) {
  failures.push('OCR 浮窗仍存在重复的 React/vendor 高度控制源')
}
if (
  !translateCardBody.includes('vision-ocr-jelly-pop')
  || !translateCardBody.includes('data-screenpilot-native-flight-active')
  || !visionAdapterSource.includes("translateCard.dataset.screenpilotNativeFlightActive === 'true'")
) {
  failures.push('OCR 结果卡没有使用与尺寸反馈隔离的落地回弹动画')
}

if (failures.length > 0) {
  failures.forEach((failure) => console.error(failure))
  process.exitCode = 1
} else {
  console.log('项目门禁通过：仓库内 vendor 完整性清单有效，旧截图路径不存在，生产接入契约有效。')
}
