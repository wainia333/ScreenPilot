// Development-only interaction fixture; never a fallback for native capture.
import { useEffect, useRef, useState } from 'react'
import { CaptureSurface } from '../../features/capture/editor/surface'
import { PinSurface } from '../../features/capture/editor/pin'
import type { CaptureSnapshot } from '../../features/capture/editor/model'
import { canvas, context2d } from '../../features/capture/editor/render'
import { captureFields } from '../../features/capture/settings-schema'
import type { CaptureBridge } from '../../features/capture/editor/bridge'
import { ScanResultSurface } from '../../features/capture/scan-result'
import { DesktopProvider } from '../../desktop/context'
const testWindow = window as Window & { captureTestActions?: { action: string; payload: unknown }[]; resolveCaptureRefresh?: () => void; resolveCaptureScroll?: () => void; resolveCapturePin?: () => void; resolveCapturePinPrepare?: () => void; resolveCapturePinPresented?: () => void; resolveCapturePinPixels?: () => void; resolveCaptureScan?: () => void; captureScrollOffset?: number }
let finishExport: (() => void) | undefined
export default function CaptureLab() {
  const [data, setData] = useState<{ snapshot: CaptureSnapshot; image: HTMLImageElement } | null>(null)
  const [scanSnapshot, setScanSnapshot] = useState<CaptureSnapshot | null>(null)
  const cursor = useRef({ x: 0, y: 0 }), scroll = useRef<{ source: HTMLCanvasElement; width: number; height: number; offset: number; count: number; horizontal: boolean } | null>(null)
  const heldPixels = useRef(false)
  const scrollSource = (width: number, height: number, horizontal: boolean) => {
    const extra = new URLSearchParams(location.search).has('long-scroll') ? 30000 : 540
    const source = canvas(width + (horizontal ? extra : 0), height + (horizontal ? 0 : extra)), c = context2d(source)
    for (let p = 0; p < (horizontal ? source.width : source.height); p++) { c.fillStyle = `rgb(${p % 251},${(p * 17) % 253},${(p * 29) % 255})`; c.fillRect(horizontal ? p : 0, horizontal ? 0 : p, horizontal ? 1 : source.width, horizontal ? source.height : 1) }
    return source
  }
  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => { cursor.current = { x: Math.round(e.clientX * window.devicePixelRatio), y: Math.round(e.clientY * window.devicePixelRatio) } }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])
  useEffect(() => {
    const parameters = new URLSearchParams(location.search)
    const width = Number(parameters.get('pin-width')) || Math.round(window.innerWidth * window.devicePixelRatio), height = Number(parameters.get('pin-height')) || Math.round(window.innerHeight * window.devicePixelRatio)
    const background = canvas(width, height), c = context2d(background)
    c.fillStyle = '#27566c'; c.fillRect(0, 0, width, height)
    c.fillStyle = '#387186'; c.fillRect(100, 80, width - 200, height - 160)
    c.fillStyle = '#e1f1f5'; c.font = '28px Segoe UI'; c.fillText('ScreenPilot · Capture reference', 155, 160)
    c.fillStyle = '#b8dce5'; c.font = '16px Segoe UI'; c.fillText('Deterministic fixture — no desktop content', 155, 200)
    for (let y = 280; y < height - 100; y += 70) { c.fillStyle = y % 140 ? '#70b1ba' : '#d1e7d3'; c.fillRect(150, y, 300, 35) }
    if (parameters.has('pixel-grid')) {
      const pixels = c.createImageData(width, height)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 4; pixels.data.set([(x * 13) % 256, (y * 17) % 256, (x + y) % 256, 255], at) }
      c.putImageData(pixels, 0, 0)
    }
    const image = new Image(); image.src = background.toDataURL()
    const options = { ...Object.fromEntries(captureFields.map(f => [f.key, f.default])), ui_scale_percent: Number(parameters.get('scale')) || 0 }
    if (parameters.has('grid-off')) Object.assign(options, { magnifier_grid: false })
    if (parameters.has('no-cross-tool')) Object.assign(options, { cross_tool_selection: false })
    if (parameters.has('no-escape-close')) Object.assign(options, { pin_escape_close: false })
    if (parameters.has('no-double-click-close')) Object.assign(options, { pin_double_click_close: false })
    if (parameters.has('decorated-pin')) Object.assign(options, { screenshot_border_enabled: true, screenshot_border_size: 8, screenshot_rounded_enabled: true })
    void image.decode().then(() => setData({ image, snapshot: { id: 'fixture', mode: parameters.get('mode') === 'record' ? 'record' : 'image', bounds: { x: 0, y: 0, width, height }, screens: [{ x: 0, y: 0, width: Math.round(window.innerWidth * window.devicePixelRatio), height: Math.round(window.innerHeight * window.devicePixelRatio) }], image: image.src, options, tools: {}, windows: [{ id: 1, title: 'Reference window', owner: 'Fixture', x: 100, y: 80, width: width - 200, height: height - 160 }], selection: null } }))
  }, [])
  if (!data) return null
  const status = { count: new URLSearchParams(location.search).has('empty-recording') ? 0 : 30, duration: 3000, bytes: 10000, dropped: 0, state: 0, timestamps: Array.from({ length: 30 }, (_, i) => i * 100) }
  const bridge: CaptureBridge = {
    snapshot: () => Promise.resolve(data.snapshot), ready: () => { testWindow.captureTestActions ??= []; testWindow.captureTestActions.push({ action: 'ready', payload: {} }); return Promise.resolve() },
    action: (id, action, payload) => {
      testWindow.captureTestActions ??= []; testWindow.captureTestActions.push({ action, payload: { id, ...payload } })
      if (action === 'pin_view' && new URLSearchParams(location.search).has('hold-pin-pixels') && !heldPixels.current && !payload?.image) {
        heldPixels.current = true
        return new Promise(resolve => { testWindow.resolveCapturePinPixels = () => resolve(null as never) })
      }
      if (action === 'nudge') {
        const direction = payload?.value as { x: number; y: number }
        cursor.current = { x: cursor.current.x + direction.x, y: cursor.current.y + direction.y }
        return Promise.resolve({ ...cursor.current } as never)
      }
      if (action === 'scroll_start') {
        const rect = payload?.rect
        if (!rect) return Promise.reject(new Error('Missing fixture scroll selection'))
        scroll.current = { source: scrollSource(rect.width, rect.height, false), width: rect.width, height: rect.height, offset: 0, count: 1, horizontal: false }
        return Promise.resolve(null as never)
      }
      if (action === 'scroll_direction' && scroll.current) {
        const state = scroll.current
        if (state.count > 1) return Promise.reject(new Error('已开始拼接，请重新开始后切换方向'))
        state.horizontal = !!payload?.value; state.source = scrollSource(state.width, state.height, state.horizontal)
        return Promise.resolve(null as never)
      }
      if (['scroll_preview', 'scroll_poll', 'scroll_step', 'scroll_finish'].includes(action)) {
        const state = scroll.current
        if (!state) return Promise.reject(new Error('Fixture scroll not started'))
        const offset = Math.min(state.horizontal ? state.source.width - state.width : state.source.height - state.height, testWindow.captureScrollOffset ?? 0), changed = offset > state.offset
        if (changed) { state.offset = offset; state.count++ }
        const width = state.width + (state.horizontal ? state.offset : 0), height = state.height + (state.horizontal ? 0 : state.offset)
        const viewport = payload?.value as { width: number; height: number } | undefined
        const fit = action === 'scroll_finish' ? 1 : state.horizontal ? (viewport?.height ?? 1200) / height : (viewport?.width ?? 600) / width
        const cropWidth = action === 'scroll_finish' || !state.horizontal ? width : Math.min(width, Math.round((viewport?.width ?? 600) / fit))
        const cropHeight = action === 'scroll_finish' || state.horizontal ? height : Math.min(height, Math.round((viewport?.height ?? 1200) / fit))
        const image = canvas(Math.max(1, Math.round(cropWidth * fit)), Math.max(1, Math.round(cropHeight * fit))), c = context2d(image)
        c.drawImage(state.source, width - cropWidth, height - cropHeight, cropWidth, cropHeight, 0, 0, image.width, image.height)
        const value = action === 'scroll_finish' ? { image: image.toDataURL(), width, height } : { preview: image.toDataURL(), width, height, count: state.count, changed, noOverlap: false }
        if (action === 'scroll_poll' && changed && new URLSearchParams(location.search).has('slow-scroll')) return new Promise(resolve => { testWindow.resolveCaptureScroll = () => resolve(value as never) })
        return Promise.resolve(value as never)
      }
      if (action === 'confirm' && new URLSearchParams(location.search).has('fail-save')) return Promise.reject(new Error('测试：磁盘写入失败'))
      if (action === 'pin' && new URLSearchParams(location.search).has('slow-pin')) return new Promise(resolve => { testWindow.resolveCapturePin = () => resolve(null as never) })
      if (action === 'pin_prepare' && new URLSearchParams(location.search).has('slow-pin-prepare')) return new Promise(resolve => { testWindow.resolveCapturePinPrepare = () => resolve(null as never) })
      if (action === 'pin_presented' && new URLSearchParams(location.search).has('slow-pin-paint')) return new Promise(resolve => { testWindow.resolveCapturePinPresented = () => resolve(null as never) })
      if (action === 'pin' && new URLSearchParams(location.search).has('fail-pin')) return Promise.reject(new Error('钉图加载失败'))
      if (action === 'scan') {
        const parameters = new URLSearchParams(location.search), rect = payload?.rect ?? data.snapshot.bounds
        const bounds = { x: Math.min(rect.x + rect.width + 10, window.innerWidth - 568), y: Math.min(rect.y, window.innerHeight - 368), width: 560, height: 360 }
        const next: CaptureSnapshot = { ...data.snapshot, id: 'scan-fixture', mode: 'scan-result', bounds, selection: rect, scanResults: null }
        setScanSnapshot(next)
        const results = parameters.has('empty-scan') ? [] : [{ text: parameters.get('scan-text') ?? '查看说明：https://example.com/help，或访问 www.example.org。', format: 'QR_CODE' }, ...(parameters.has('multi-scan') ? [{ text: '6901234567890', format: 'EAN_13' }] : [])]
        const finish = () => setScanSnapshot({ ...next, scanResults: results })
        if (parameters.has('slow-scan')) return new Promise(resolve => { testWindow.resolveCaptureScan = () => { finish(); resolve(null as never) } })
        finish(); return Promise.resolve(null as never)
      }
      if (action === 'copy_text' && new URLSearchParams(location.search).has('fail-copy')) return Promise.reject(new Error('系统剪贴板正忙'))
      if (action === 'open_link' && new URLSearchParams(location.search).has('fail-link')) return Promise.reject(new Error('默认浏览器无法打开链接'))
      if (action === 'cancel' && scanSnapshot) { setScanSnapshot(null); return Promise.resolve(null as never) }
      if (action === 'refresh') {
        if (new URLSearchParams(location.search).has('fail-refresh')) return Promise.reject(new Error('测试：捕获后端不可用'))
        const fresh = canvas(data.image.width, data.image.height), c = context2d(fresh)
        c.fillStyle = '#4a9d82'; c.fillRect(0, 0, fresh.width, fresh.height)
        if (new URLSearchParams(location.search).has('slow-refresh')) return new Promise(resolve => { testWindow.resolveCaptureRefresh = () => resolve({ image: fresh.toDataURL() } as never) })
        return Promise.resolve({ image: fresh.toDataURL() } as never)
      }
      return Promise.resolve((action.startsWith('record_') ? status : null) as never)
    },
    frame: async (id, index, showCursor) => { testWindow.captureTestActions ??= []; testWindow.captureTestActions.push({ action: 'frame', payload: { id, index, showCursor } }); return (await fetch(data.image.src)).arrayBuffer() },
    export: (id, options) => {
      testWindow.captureTestActions ??= []; testWindow.captureTestActions.push({ action: 'export', payload: { id, ...options } })
      if (new URLSearchParams(location.search).has('fail-export')) return Promise.reject(new Error('导出失败：Access is denied. (os error 5)\n    at capture_export (runtime.rs:42)\n请检查目标目录权限。'.repeat(8)))
      if (new URLSearchParams(location.search).has('slow-export')) return new Promise(resolve => { finishExport = () => resolve({ cancelled: true }) })
      return Promise.resolve({ path: 'fixture.gif' })
    },
    cancelExport: () => { testWindow.captureTestActions ??= []; testWindow.captureTestActions.push({ action: 'cancel_export', payload: {} }); finishExport?.(); finishExport = undefined; return Promise.resolve() },
    session: () => Promise.resolve(() => { /* fixture session is immutable */ }),
  }
  const restored = new URLSearchParams(location.search).has('restore-pin') ? { view: { zoom: 0.75, rotation: 90, flipH: true, flipV: false }, crop: null, opacity: 0.5, toolbar: false, marks: [], offset: { x: 12, y: 12 } } : undefined
  if (scanSnapshot) return <DesktopProvider><div style={{ position: 'fixed', left: scanSnapshot.bounds.x, top: scanSnapshot.bounds.y, width: scanSnapshot.bounds.width, height: scanSnapshot.bounds.height }}><ScanResultSurface snapshot={scanSnapshot} bridge={bridge} /></div></DesktopProvider>
  const retainedFrame = new URLSearchParams(location.search).has('selection-frame') ? { view: { zoom: 1, rotation: 0, flipH: false, flipV: false }, crop: null, opacity: 1, toolbar: false, marks: [], offset: { x: 12, y: 12 }, frame: { width: 4, color: '#3388ff', radius: 0 } } : undefined
  const pinState = retainedFrame ?? restored
  // In this browser fixture the host starts at (0, 0) and the pin's image at
  // (12, 12), just as the native host includes its transparent frame padding.
  return new URLSearchParams(location.search).get('mode') === 'pin' ? <PinSurface snapshot={{ ...data.snapshot, bounds: { ...data.snapshot.bounds, x: 12, y: 12 }, mode: 'pin', ...(pinState ? { pinState } : {}) }} image={data.image} bridge={bridge} nativePixels={new URLSearchParams(location.search).has('native-pixels')} /> : <CaptureSurface {...data} bridge={bridge} />
}
