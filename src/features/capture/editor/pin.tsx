import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import type { SettingsChangedEvent } from '../../../desktop/contract'
import type { CSSProperties, PointerEvent } from 'react'
import { captureBridge, type CaptureBridge } from './bridge'
import { CaptureScene } from './scene'
import { canvas, context2d, drawDocument, exportSelection } from './render'
import { CaptureToolbar } from './toolbar'
import { clamp, rectBetween, screenFor, type CaptureSnapshot, type Point, type Rect, type ToolAction } from './model'
import { cropCenter, mapPinPoint, originalTransform, pinEdgeRect, pinEdges, pinSize, regionCrop, resizePin, thumbnailCrop, type PinCrop, type PinEdge, type PinTransform } from './pin-geometry'
import { observeInteractionRegions } from './interaction-regions'
import { isTauriRuntime } from '../../../desktop/runtime'
import { CaptureNotice } from './notice'
import { capturePreferences } from './preferences'
import { drawPinFrame, pinPixels } from './pin-pixels'
import { LatestUpdate } from './latest-update'
import { PopupMenu, PopupMenuItem as PinMenuItem } from '../../../shared/ui/popup-menu'
import { popupMenuHeight, popupMenuScale, POPUP_MENU_SHADOW, POPUP_MENU_WIDTH } from '../../../shared/ui/popup-menu-layout'

type PixelPacket = { image: string; initial: string | null; sourceGeneration: number; area: Rect; generation: number; visual: { state: NonNullable<CaptureSnapshot['pinState']>; focused: boolean; color: string; rounded: boolean } }
type GeometryPacket = { width: number; height: number; position: Point; rects: Rect[]; signature: string; packet: PixelPacket | null; opacity: number }

export function PinSurface({ snapshot, image, bridge = captureBridge, nativePixels = isTauriRuntime() }: { snapshot: CaptureSnapshot; image: HTMLImageElement; bridge?: CaptureBridge; nativePixels?: boolean }) {
  const scene = useMemo(() => new CaptureScene({ ...snapshot, marks: snapshot.pinState?.marks ?? snapshot.marks ?? null, bounds: { ...snapshot.bounds, width: image.width, height: image.height }, selection: null }), [snapshot, image])
  const revision = useSyncExternalStore(scene.subscribe, scene.getSnapshot)
  const baseline = useMemo(() => ({ ...structuredClone(snapshot.tools), ...structuredClone(scene.styles) }), [snapshot, scene])
  const [view, setView] = useState(snapshot.pinState?.view ?? originalTransform), [crop, setCrop] = useState<PinCrop | null>(snapshot.pinState?.crop ?? null), [opacity, setOpacity] = useState(snapshot.pinState?.opacity ?? Number(snapshot.options.pin_default_opacity ?? 1))
  const [toolbar, setToolbar] = useState(snapshot.pinState?.toolbar ?? !!snapshot.options.pin_auto_toolbar), [menu, setMenu] = useState<Point | null>(null), [error, setError] = useState('')
  const [region, setRegion] = useState<ReturnType<typeof rectBetween> | null>(null)
  const [focused, setFocused] = useState(true)
  const [themeColor, setThemeColor] = useState(String(snapshot.options.theme_color ?? '#3388ff'))
  const [escapeClose, setEscapeClose] = useState(snapshot.options.pin_escape_close !== false)
  const [doubleClickClose, setDoubleClickClose] = useState(snapshot.options.pin_double_click_close !== false)
  const documentRef = useRef<HTMLCanvasElement>(null), chromeRef = useRef<HTMLCanvasElement>(null), pinRef = useRef<HTMLDivElement>(null), stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLCanvasElement>(null), retainedFrame = snapshot.pinState?.frame
  const frame = useMemo(() => ({ width: 1, color: focused ? themeColor : '#89919e', radius: retainedFrame?.radius ?? (snapshot.options.pin_rounded_corners ? 8 : 0) }), [focused, themeColor, snapshot.options.pin_rounded_corners, retainedFrame])
  const padding = 12
  const cursor = useRef<Point | null>(null), windowDrag = useRef<Point | null>(null), rightDrag = useRef<{ start: Point; client: Point; moved: boolean } | null>(null), closing = useRef(false)
  const resizeChain = useRef(Promise.resolve()), saveChain = useRef(Promise.resolve()), shift = useRef({ x: 0, y: 0 }), shape = useRef({ width: 0, height: 0 })
  const resizeDrag = useRef<{ edge: PinEdge; start: Point; size: { width: number; height: number }; view: PinTransform; crop: PinCrop | null; shift: Point } | null>(null)
  const requestedPosition = useRef({ x: 0, y: 0 }), appliedPosition = useRef({ x: 0, y: 0 })
  const readySent = useRef(false)
  const [presented, setPresented] = useState(false)
  const nativePacket = useRef<PixelPacket | null>(null)
  const pixelGeneration = useRef(0)
  const uploadedGeneration = useRef(-1)
  const latestPinState = useRef('')
  const sourcePacket = useRef({ image: '', generation: 0, signature: '' }), uploadedSource = useRef(-1)
  const pinMounted = useRef(true)
  const backing = useMemo(() => { const c = canvas(image.width, image.height); context2d(c).drawImage(image, 0, 0); return c }, [image])
  const uiScale = Number(snapshot.options.ui_scale_percent) / 100 || (window.devicePixelRatio > 1.5 ? 1.5 : window.devicePixelRatio > 1 ? 1.25 : 1)
  const picture = pinSize(image.width, image.height, view, crop), ratio = window.devicePixelRatio
  const initialScreen = screenFor(snapshot.bounds, snapshot.screens) ?? snapshot.bounds
  const [available, setAvailable] = useState<Rect>({ ...initialScreen, x: initialScreen.x - snapshot.bounds.x, y: initialScreen.y - snapshot.bounds.y })
  const menuOpen = menu !== null
  const toolbarWidth = 556 * uiScale, toolbarHeight = 40 * uiScale
  const toolbarGap = padding + 12
  const toolbarBelow = picture.height + 2 + toolbarHeight + 110 * uiScale <= available.y + available.height
  const toolbarAt = { x: clamp(picture.width - toolbarWidth, available.x, available.x + available.width - toolbarWidth), y: clamp(toolbarBelow ? picture.height + toolbarGap : -toolbarHeight - toolbarGap, available.y + (toolbarBelow ? 0 : 110 * uiScale), available.y + available.height - toolbarHeight - (toolbarBelow ? 110 * uiScale : 0)) }
  const offset = useMemo(() => ({ x: toolbar && !crop ? Math.max(12, 12 - toolbarAt.x) : 12, y: toolbar && !crop ? Math.max(12, 12 - toolbarAt.y + (toolbarBelow ? 0 : 110 * uiScale)) : 12 }), [toolbar, crop, toolbarAt.x, toolbarAt.y, toolbarBelow, uiScale])
  const previousOffset = useRef({ x: 12, y: 12 }), currentOffset = useRef(offset)
  const geometry = useRef({ picture, offset, opacity })
  useLayoutEffect(() => { currentOffset.current = offset }, [offset])
  useLayoutEffect(() => { geometry.current = { picture, offset, opacity } }, [picture, offset, opacity])
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined
    const focus = () => setFocused(true), blur = () => setFocused(false)
    window.addEventListener('focus', focus); window.addEventListener('blur', blur)
    if (isTauriRuntime()) void getCurrentWindow().onFocusChanged(e => { if (!disposed) setFocused(e.payload) }).then(stop => { if (disposed) stop(); else unlisten = stop }).catch((e: unknown) => setError(String(e)))
    return () => { disposed = true; unlisten?.(); window.removeEventListener('focus', focus); window.removeEventListener('blur', blur) }
  }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false, unlisten: (() => void) | undefined
    void listen<SettingsChangedEvent>('screenpilot:settings-changed', event => {
      if (disposed) return
      const options = event.payload.settings.capture.nativeOptions
      setThemeColor(String(options.theme_color ?? '#3388ff'))
      setEscapeClose(options.pin_escape_close !== false)
      setDoubleClickClose(options.pin_double_click_close !== false)
    }).then(stop => { if (disposed) stop(); else unlisten = stop }).catch((e: unknown) => setError(String(e)))
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(() => {
    if (!toolbar && !menuOpen) return
    let disposed = false, unlisten: (() => void) | undefined, timer: ReturnType<typeof setTimeout>
    const update = () => { clearTimeout(timer); timer = setTimeout(() => { void resizeChain.current.then(() => bridge.action<{ x: number; y: number; screen: Rect } | null>(snapshot.id, 'pin_metrics')).then(metrics => { if (!metrics || disposed) return; const inset = currentOffset.current; setAvailable({ ...metrics.screen, x: metrics.screen.x - metrics.x - inset.x, y: metrics.screen.y - metrics.y - inset.y }) }).catch((e: unknown) => { if (!disposed) setError(String(e)) }) }, 80) }
    update()
    if (isTauriRuntime()) void getCurrentWindow().onMoved(update).then(stop => { if (disposed) stop(); else unlisten = stop }).catch((e: unknown) => setError(String(e)))
    return () => { disposed = true; clearTimeout(timer); unlisten?.() }
  }, [toolbar, menuOpen, bridge, snapshot.id, picture.width, picture.height])
  const persist = useCallback(() => {
    const value = capturePreferences(scene, baseline).tools
    const next = saveChain.current.then(async () => { await bridge.action(snapshot.id, 'tools', { value }) })
    saveChain.current = next.catch((e: unknown) => setError(String(e)))
    return next
  }, [bridge, snapshot, scene, baseline])
  useEffect(() => { scene.setCommit(() => { void persist().catch(() => { /* displayed by queue */ }) }); return () => scene.setCommit(() => { /* detached */ }) }, [scene, persist])
  const close = useCallback(() => {
    if (closing.current) return
    closing.current = true
    void bridge.action(snapshot.id, 'cancel', { preferences: capturePreferences(scene, baseline) }).catch((e: unknown) => { closing.current = false; setError(String(e)) })
  }, [bridge, snapshot.id, scene, baseline])
  const action = useCallback((name: ToolAction) => {
    if (name === 'cancel') { close(); return } if (name === 'undo') { scene.undo(); return } if (name === 'redo') { scene.redo(); return }
    scene.finishText(); const composed = exportSelection(scene, backing)
    const size = pinSize(composed.width, composed.height, { ...view, zoom: 1 }, null), result = canvas(size.width, size.height), c = context2d(result)
    c.translate(result.width / 2, result.height / 2); c.scale(view.flipH ? -1 : 1, view.flipV ? -1 : 1); c.rotate(view.rotation * Math.PI / 180); c.drawImage(composed, -composed.width / 2, -composed.height / 2)
    void persist().then(() => bridge.action(snapshot.id, name === 'confirm' ? 'copy' : name, { image: result.toDataURL(), rect: snapshot.bounds })).catch((e: unknown) => setError(String(e)))
  }, [backing, bridge, close, view, scene, snapshot, persist])
  const transform = useCallback((next: PinTransform, anchor?: Point) => {
    if (crop) return
    const p = anchor ?? { x: image.width / 2, y: image.height / 2 }
    const before = mapPinPoint(p, image.width, image.height, view), after = mapPinPoint(p, image.width, image.height, next)
    shift.current.x += before.x - after.x; shift.current.y += before.y - after.y; setView(next)
  }, [crop, image, view])
  const enterCrop = useCallback((next: PinCrop, anchor: Point) => {
    scene.finishText(); scene.setTool('cursor', false)
    shift.current.x += anchor.x - next.rect.width * next.scale / 2; shift.current.y += anchor.y - next.rect.height * next.scale / 2
    setToolbar(false); setMenu(null); setCrop(next)
  }, [scene])
  const toggleThumbnail = useCallback(() => {
    if (crop) {
      const after = mapPinPoint(cropCenter(crop), image.width, image.height, view)
      shift.current.x += picture.width / 2 - after.x; shift.current.y += picture.height / 2 - after.y; setCrop(null)
    } else {
      const point = cursor.current ?? { x: image.width / 2, y: image.height / 2 }
      enterCrop(thumbnailCrop(point, image.width, image.height), mapPinPoint(point, image.width, image.height, view))
    }
  }, [crop, image, view, picture.width, picture.height, enterCrop])
  const contentSignature = JSON.stringify({ marks: scene.marks, region }), regionZoom = region ? view.zoom : 1
  useLayoutEffect(() => {
    if (documentRef.current) drawDocument(context2d(documentRef.current), scene, backing)
    if (chromeRef.current) { const c = context2d(chromeRef.current); c.clearRect(0, 0, image.width, image.height); if (region) { c.fillStyle = '#40e0d030'; c.fillRect(region.x, region.y, region.width, region.height); c.strokeStyle = '#40e0d0'; c.lineWidth = 2 / regionZoom; c.strokeRect(region.x, region.y, region.width, region.height) } }
    if (nativePixels && documentRef.current && chromeRef.current && sourcePacket.current.signature !== contentSignature) {
      const composed = canvas(image.width, image.height), c = context2d(composed)
      c.drawImage(documentRef.current, 0, 0); c.drawImage(chromeRef.current, 0, 0)
      sourcePacket.current = { image: composed.toDataURL(), generation: sourcePacket.current.generation + 1, signature: contentSignature }
    }
  }, [scene, backing, revision, region, image, regionZoom, nativePixels, contentSignature])
  useLayoutEffect(() => {
    if (!frameRef.current) return
    const ctx = context2d(frameRef.current); ctx.clearRect(0, 0, frameRef.current.width, frameRef.current.height)
    drawPinFrame(ctx, { x: padding, y: padding, width: picture.width, height: picture.height }, frame)
  }, [frame, padding, picture.width, picture.height])
  useLayoutEffect(() => {
    if (!nativePixels || !documentRef.current || !chromeRef.current) return
    // Only the initial handoff uses a display PNG. Subsequent sizes reuse the
    // unscaled document cached in Rust; wheel/focus changes send small metadata.
    const raster = !presented ? pinPixels(documentRef.current, chromeRef.current, view, crop, retainedFrame, {
      rounded: !!snapshot.options.pin_rounded_corners, color: frame.color,
    }, opacity, true) : null
    const inset = raster?.padding ?? padding
    const area = { x: Math.round(offset.x - inset), y: Math.round(offset.y - inset), width: Math.round(picture.width) + inset * 2, height: Math.round(picture.height) + inset * 2 }
    const state = { view, crop, opacity, toolbar, marks: structuredClone(scene.marks), offset, frame }
    nativePacket.current = { image: sourcePacket.current.image, sourceGeneration: sourcePacket.current.generation, initial: raster?.image.toDataURL() ?? null, area, generation: ++pixelGeneration.current, visual: { state, focused, color: themeColor, rounded: !!snapshot.options.pin_rounded_corners } }
    if (stageRef.current) stageRef.current.dataset.pixelRevision = String(pixelGeneration.current)
  }, [nativePixels, contentSignature, view, crop, frame, snapshot.options, opacity, offset, presented, padding, retainedFrame, picture.width, picture.height, toolbar, focused, scene, themeColor])
  const updates = useRef<LatestUpdate<GeometryPacket> | null>(null)
  useLayoutEffect(() => {
    updates.current = new LatestUpdate<GeometryPacket>(async update => {
      const active = () => pinMounted.current && !closing.current
      if (!active()) return
      if (nativePixels && readySent.current && update.packet?.initial) return
      try {
        const delta = { x: Math.round(update.position.x) - appliedPosition.current.x, y: Math.round(update.position.y) - appliedPosition.current.y }
        const packet = update.packet
        if (nativePixels && readySent.current && packet) {
          const sourceChanged = uploadedSource.current !== packet.sourceGeneration
          await bridge.action(snapshot.id, 'pin_view', { ...(sourceChanged ? { image: packet.image } : {}), rect: packet.area, value: { width: update.width, height: update.height, dx: delta.x, dy: delta.y, regions: update.rects, visual: packet.visual } })
          uploadedSource.current = packet.sourceGeneration
        } else {
          const sizeChanged = shape.current.width !== update.width || shape.current.height !== update.height || !!delta.x || !!delta.y
          if (sizeChanged) await bridge.action(snapshot.id, 'pin_resize', { ...(packet ? { rect: packet.area } : {}), value: { width: update.width, height: update.height, dx: delta.x, dy: delta.y } })
          await bridge.action(snapshot.id, 'pin_interaction', { value: update.rects })
          if (nativePixels && packet?.initial && uploadedGeneration.current !== packet.generation) {
            await bridge.action(snapshot.id, 'pin_pixels', { image: packet.initial, rect: packet.area })
            uploadedGeneration.current = packet.generation
          }
        }
        appliedPosition.current = { x: Math.round(update.position.x), y: Math.round(update.position.y) }
        shape.current = { width: update.width, height: update.height }
        if (!readySent.current && active()) {
          await bridge.ready(snapshot.id)
          const r = pinRef.current?.getBoundingClientRect(); if (!r) throw new Error('钉图画面已关闭')
          await bridge.action(snapshot.id, 'pin_presented', { rect: nativePixels && packet ? packet.area : { x: Math.round(r.x * ratio), y: Math.round(r.y * ratio), width: Math.round(r.width * ratio), height: Math.round(r.height * ratio) }, value: { opacity: update.opacity } })
          readySent.current = true
          if (active()) setPresented(true)
        }
      } catch (e) { if (active()) setError(String(e)) }
    })
    return () => { updates.current = null }
  }, [bridge, snapshot.id, nativePixels, ratio])
  useLayoutEffect(() => {
    const root = stageRef.current, queue = updates.current; if (!root || !queue) return
    let previous = '', disposed = false, sentPixels = -1
    const stop = observeInteractionRegions(document.body, '.jt-pin-image, .jt-pin-frame, .jt-panel, .sp-popup-menu, .save-success-toast, [data-capture-interactive]', elements => {
      if (disposed) return
      const { picture, offset, opacity } = geometry.current
      const rects = elements.map(element => { const r = element.getBoundingClientRect(); return { x: Math.floor(r.x * ratio) - 3, y: Math.floor(r.y * ratio) - 3, width: Math.ceil(r.width * ratio) + 6, height: Math.ceil(r.height * ratio) + 6 } })
      const chromePadding = Math.max(8, POPUP_MENU_SHADOW * uiScale)
      const width = Math.ceil(Math.max(picture.width + offset.x + 12, ...rects.map(r => r.x + r.width + chromePadding))), height = Math.ceil(Math.max(picture.height + offset.y + 12, ...rects.map(r => r.y + r.height + chromePadding)))
      const delta = { x: shift.current.x + previousOffset.current.x - offset.x, y: shift.current.y + previousOffset.current.y - offset.y }; shift.current = { x: 0, y: 0 }; previousOffset.current = offset
      requestedPosition.current.x += delta.x; requestedPosition.current.y += delta.y
      const sizeChanged = shape.current.width !== width || shape.current.height !== height || !!delta.x || !!delta.y
      const packet = nativePacket.current, pixelsChanged = nativePixels && packet && packet.generation !== sentPixels
      const signature = JSON.stringify(rects); if (!sizeChanged && previous === signature && !pixelsChanged) return; previous = signature
      if (packet) sentPixels = packet.generation
      resizeChain.current = queue.push({ width, height, position: { ...requestedPosition.current }, rects, signature, packet, opacity })
    })
    return () => { disposed = true; stop() }
  }, [ratio, nativePixels, updates, uiScale])
  const pinState = JSON.stringify({ view, crop, opacity, toolbar, marks: scene.marks, offset, frame })
  useLayoutEffect(() => { latestPinState.current = pinState }, [pinState])
  useEffect(() => { pinMounted.current = true; return () => { pinMounted.current = false } }, [])
  useLayoutEffect(() => {
    // Queue after geometry updates so saved position refers to the picture's
    // upper-left corner, independently of toolbar/menu padding around the HWND.
    // Native canvas updates do not require a WebView paint; commit the save queue
    // during layout as well, instead of waiting for a passive paint effect.
    const timer = setTimeout(() => {
      saveChain.current = saveChain.current.then(async () => {
        await resizeChain.current
        if (pinMounted.current && !closing.current) await bridge.action(snapshot.id, 'pin_state', { value: JSON.parse(latestPinState.current) as unknown })
      }).catch((e: unknown) => { if (pinMounted.current) setError(String(e)) })
    }, 180)
    return () => { clearTimeout(timer) }
  }, [bridge, snapshot.id, pinState, scene.drag, scene.textEditing])
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!readySent.current && e.key !== 'Escape') return
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Escape') { e.preventDefault(); if (menu) setMenu(null); else if (escapeClose) close(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); action('copy') }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); action('save') }
      if (e.key === ' ') { e.preventDefault(); if (!crop) setToolbar(value => !value) }
      if (e.key.toLowerCase() === 'r' && !e.repeat) toggleThumbnail()
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) scene.redo(); else scene.undo() }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); scene.redo() }
      if (e.key === 'Delete') scene.deleteSelected()
    }
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener)
  }, [action, close, crop, escapeClose, menu, scene, toggleThumbnail])
  const point = (e: { clientX: number; clientY: number }) => {
    const r = pinRef.current?.getBoundingClientRect(); if (!r) return { x: 0, y: 0 }
    const local = { x: (e.clientX - r.x) * ratio, y: (e.clientY - r.y) * ratio }
    return crop ? { x: crop.rect.x + local.x / crop.scale, y: crop.rect.y + local.y / crop.scale } : mapPinPoint(local, image.width, image.height, view, true)
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!readySent.current) return
    cursor.current = point(e)
    if (e.button === 1) { e.preventDefault(); close(); return }
    if (e.button === 2) { e.currentTarget.setPointerCapture(e.pointerId); rightDrag.current = { start: point(e), client: { x: e.clientX, y: e.clientY }, moved: false }; return }
    if (e.button !== 0) return
    setMenu(null)
    if (crop || scene.tool === 'cursor') {
      if (!crop && toolbar) { scene.down(point(e), e.ctrlKey); if (scene.selected || e.ctrlKey) { e.currentTarget.setPointerCapture(e.pointerId); return } scene.up() }
      // Do not enter a native move loop for a click: that consumes WebView dblclick.
      windowDrag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); return
    }
    e.currentTarget.setPointerCapture(e.pointerId); scene.down(point(e), e.ctrlKey)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) {
      const drag = rightDrag.current; rightDrag.current = null
      if (drag?.moved && !crop) {
        const next = regionCrop(rectBetween(drag.start, point(e)), image.width, image.height, view.zoom)
        if (next) enterCrop(next, mapPinPoint(cropCenter(next), image.width, image.height, view))
      } else if (drag) setMenu({ x: e.clientX * ratio, y: e.clientY * ratio })
      setRegion(null); return
    }
    if (e.button === 0) { windowDrag.current = null; scene.up() }
  }
  const beginResize = (e: PointerEvent<HTMLDivElement>, edge: PinEdge) => {
    if (!readySent.current || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); scene.finishText(); setMenu(null); setFocused(true)
    resizeDrag.current = { edge, start: { x: e.screenX, y: e.screenY }, size: picture, view, crop, shift: { x: 0, y: 0 } }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const resize = (e: PointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current; if (!drag) return
    const zoom = drag.crop?.scale ?? drag.view.zoom
    const min = Math.max(0.05 / zoom, Math.min(50 / drag.size.width, 50 / drag.size.height))
    const max = Math.min(8 / zoom, 32744 / Math.max(drag.size.width, drag.size.height), Math.sqrt(90_000_000 / (drag.size.width * drag.size.height)))
    const next = resizePin(drag.edge, drag.size, { x: (e.screenX - drag.start.x) * ratio, y: (e.screenY - drag.start.y) * ratio }, Math.min(min, max), max)
    shift.current.x += next.shift.x - drag.shift.x; shift.current.y += next.shift.y - drag.shift.y; drag.shift = next.shift
    if (drag.crop) setCrop({ ...drag.crop, scale: drag.crop.scale * next.scale })
    else setView({ ...drag.view, zoom: drag.view.zoom * next.scale })
  }
  const endResize = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizeDrag.current) return
    resize(e); resizeDrag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const pinLayout: CaptureSnapshot['tools']['layout'] = ['pen', 'mosaic', 'arrow', 'number', 'shape', 'text', 'eraser', 'undo', 'redo', 'save', 'copy'].map(key => ({ key: key as ToolAction, mode: 'show' }))
  const editingText = scene.marks.find(m => m.id === scene.textEditing)
  const menuHeight = popupMenuHeight(10, 3)
  const menuScale = popupMenuScale(uiScale, available.width, available.height, menuHeight)
  const menuShadow = POPUP_MENU_SHADOW * menuScale
  const menuAt = menu ? {
    x: clamp(menu.x, Math.max(0, available.x + offset.x) + menuShadow, Math.max(menuShadow, available.x + offset.x + available.width - POPUP_MENU_WIDTH * menuScale - menuShadow)),
    y: clamp(menu.y, Math.max(0, available.y + offset.y) + menuShadow, Math.max(menuShadow, available.y + offset.y + available.height - menuHeight * menuScale - menuShadow)),
  } : null
  const originalPixels = !crop && view.zoom === 1 && view.rotation === 0 && !view.flipH && !view.flipV
  // Cancel the physical stage's DPI transform for the image and size its
  // canvases in CSS pixels. 1:1 pixels must never be filtered twice at 125/150%.
  const documentStyle: CSSProperties = crop ? { left: -crop.rect.x * crop.scale / ratio, top: -crop.rect.y * crop.scale / ratio, width: image.width / ratio, height: image.height / ratio, transformOrigin: '0 0', transform: `scale(${crop.scale})` } : originalPixels ? { left: 0, top: 0, width: image.width / ratio, height: image.height / ratio, transform: 'none' } : { left: picture.width / 2 / ratio, top: picture.height / 2 / ratio, width: image.width / ratio, height: image.height / ratio, transformOrigin: 'center', transform: `translate(-50%,-50%) scale(${view.zoom * (view.flipH ? -1 : 1)},${view.zoom * (view.flipV ? -1 : 1)}) rotate(${view.rotation}deg)` }
  return <div className="jt-surface jt-pin" data-focused={focused} data-native-pixels={nativePixels || undefined} onContextMenu={e => e.preventDefault()}>
    <div ref={stageRef} className="jt-pin-stage" style={{ width: picture.width + offset.x + 12, height: picture.height + offset.y + 12, transform: `scale(${1 / ratio})`, '--jt-accent': themeColor } as CSSProperties}>
      <div ref={pinRef} className="jt-pin-image" style={{ left: offset.x, top: offset.y, width: picture.width / ratio, height: picture.height / ratio, transform: `scale(${ratio})`, transformOrigin: '0 0', opacity, borderRadius: frame.radius / ratio, boxShadow: 'none', cursor: crop || scene.tool === 'cursor' ? 'move' : 'crosshair' }}
        onMouseLeave={() => { if (!rightDrag.current) cursor.current = null }}
        onWheel={e => {
          if (!readySent.current || crop || !e.deltaY) return
          if (e.ctrlKey) setOpacity(v => clamp(v + (e.deltaY < 0 ? 0.05 : -0.05), 0.15, 1))
          // No translation: the displayed image's upper-left corner stays fixed,
          // including after rotation/flip and when the toolbar changes its inset.
          else setView(v => ({ ...v, zoom: clamp(v.zoom * (e.deltaY < 0 ? 1.05 : 1 / 1.05), Math.min(8, Math.max(0.05, 50 / image.width, 50 / image.height)), Math.min(8, 32744 / Math.max(image.width, image.height), Math.sqrt(90_000_000 / (image.width * image.height)))) }))
        }}>
        <div className="jt-pin-document" style={{ ...documentStyle, imageRendering: originalPixels ? 'pixelated' : 'auto' }}>
          <canvas ref={documentRef} width={image.width} height={image.height} style={{ width: '100%', height: '100%' }} />
          <canvas ref={chromeRef} width={image.width} height={image.height} style={{ width: '100%', height: '100%' }} />
          {editingText && <textarea autoFocus className="jt-text-editor" aria-label="标注文字" value={editingText.text} style={{ left: editingText.points[0].x / ratio, top: editingText.points[0].y / ratio, fontSize: editingText.style.fontSize * 96 / 72 / ratio, fontWeight: editingText.style.bold ? 700 : 400, fontStyle: editingText.style.italic ? 'italic' : 'normal', textDecoration: editingText.style.underline ? 'underline' : 'none', fontFamily: editingText.style.font, color: editingText.style.color, width: 220 / ratio, height: 90 / ratio }} onChange={e => scene.editText(editingText.id, e.target.value)} onBlur={() => scene.finishText()} />}
        </div>
        {!editingText && <div className="jt-pin-input" onPointerDown={down} onPointerMove={e => {
          cursor.current = point(e)
          const moving = windowDrag.current
          if (moving && Math.hypot(e.clientX - moving.x, e.clientY - moving.y) > 3) {
            windowDrag.current = null; e.currentTarget.releasePointerCapture(e.pointerId)
            if (isTauriRuntime()) void getCurrentWindow().startDragging().catch((e: unknown) => setError(String(e)))
            return
          }
          const drag = rightDrag.current
          if (drag && !crop) { if (Math.abs(e.clientX - drag.client.x) + Math.abs(e.clientY - drag.client.y) > 6) { drag.moved = true; setRegion(rectBetween(drag.start, point(e))) } }
          else if (scene.drag) scene.move(point(e), e.shiftKey)
        }} onPointerUp={up} onPointerCancel={() => { windowDrag.current = null; rightDrag.current = null; setRegion(null); scene.up() }} onDoubleClick={e => { e.preventDefault(); if (doubleClickClose) close() }} />}
      </div>
      <canvas ref={frameRef} className="jt-pin-frame" width={Math.round(picture.width) + padding * 2} height={Math.round(picture.height) + padding * 2} style={{ left: offset.x - padding, top: offset.y - padding, width: (Math.round(picture.width) + padding * 2) / ratio, height: (Math.round(picture.height) + padding * 2) / ratio, transform: `scale(${ratio})`, transformOrigin: '0 0', imageRendering: 'pixelated', opacity }} />
      {pinEdges.map(edge => { const r = pinEdgeRect(edge, picture, ratio); return <div key={edge} data-pin-edge={edge} className={`jt-pin-resize jt-pin-resize--${edge}`} style={{ left: offset.x + r.x, top: offset.y + r.y, width: r.width, height: r.height }} onPointerDown={e => beginResize(e, edge)} onPointerMove={resize} onPointerUp={endResize} onPointerCancel={e => { resizeDrag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }} onLostPointerCapture={() => { resizeDrag.current = null }} /> })}
      {toolbar && !crop && <CaptureToolbar scene={scene} scale={uiScale} action={action} persist={() => { void persist().catch(() => { /* reported */ }) }} fixedLayout={pinLayout} fixedPosition={{ x: offset.x + toolbarAt.x, y: offset.y + toolbarAt.y }} fixedBelow={toolbarBelow} screenBounds={{ ...available, x: Math.max(0, available.x + offset.x), y: Math.max(0, available.y + offset.y) }} />}
      {menuAt && <PopupMenu className="jt-pin-menu" label="钉图菜单" style={{ left: menuAt.x, top: menuAt.y, transform: `scale(${menuScale})` }} onClick={() => setMenu(null)}>
        <PinMenuItem label="复制图片" shortcut="Ctrl+C" onClick={() => action('copy')} />
        <PinMenuItem label="另存为…" shortcut="Ctrl+S" onClick={() => action('save')} />
        <div role="separator" />
        <PinMenuItem label={toolbar ? '隐藏工具条' : '显示工具条'} shortcut="Space" onClick={() => setToolbar(v => !v)} disabled={!!crop} />
        <PinMenuItem label="恢复原始大小" onClick={() => transform(originalTransform)} disabled={!!crop} />
        <PinMenuItem label={crop ? '恢复完整图片' : '缩略图'} shortcut="R" onClick={toggleThumbnail} />
        <div role="separator" />
        <PinMenuItem label="顺时针旋转 90°" onClick={() => transform({ ...view, rotation: (view.rotation + 90) % 360 })} disabled={!!crop} />
        <PinMenuItem label="逆时针旋转 90°" onClick={() => transform({ ...view, rotation: (view.rotation + 270) % 360 })} disabled={!!crop} />
        <PinMenuItem label="水平翻转" onClick={() => transform({ ...view, flipH: !view.flipH })} disabled={!!crop} />
        <PinMenuItem label="垂直翻转" onClick={() => transform({ ...view, flipV: !view.flipV })} disabled={!!crop} />
        <div role="separator" />
        <PinMenuItem label="关闭钉图" shortcut={escapeClose ? 'Esc' : ''} destructive onClick={close} />
      </PopupMenu>}
      {error && <CaptureNotice message={error} tone="error" onDismiss={() => setError('')} />}
    </div>
  </div>
}
