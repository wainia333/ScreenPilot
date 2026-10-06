import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { isTauriRuntime } from '../../../desktop/runtime'
import { CaptureScene } from './scene'
import { canvas, context2d, drawChrome, drawDocument, drawRetainedChrome, exportPinSelection, exportSelection, framePadding, selectionFrame, invalidateMosaic } from './render'
import { CaptureToolbar } from './toolbar'
import { Magnifier } from './magnifier'
import { pixelColor } from './pixel-color'
import { captureBridge } from './bridge'
import type { CaptureBridge, CapturePayload } from './bridge'
import { capturePreferences } from './preferences'
import { clamp, contains, markBounds } from './model'
import type { CaptureSnapshot, Point, Rect, Tool, ToolAction } from './model'
import { RecordingControls } from './recording'
import './capture.css'
import { PinSurface } from './pin'
import { SelectionInfo } from './selection-info'
import { ScrollControls } from './scrolling'
import { observeInteractionRegions } from './interaction-regions'
import { CaptureRenderBoundary } from './render-boundary'
import { CaptureNotice } from './notice'
import { captureWindowRegions } from './window-regions'
type RecordState = 'ready' | 'recording' | 'paused' | 'playback'
export function CaptureSurface({ snapshot, image, bridge = captureBridge }: { snapshot: CaptureSnapshot; image: HTMLImageElement; bridge?: CaptureBridge }) {
  const scene = useMemo(() => new CaptureScene(snapshot), [snapshot])
  const revision = useSyncExternalStore(scene.subscribe, scene.getSnapshot)
  const [error, setError] = useState(''), [working, setWorking] = useState(false)
  const [record, setRecord] = useState<RecordState | null>(null), [scroll, setScroll] = useState(false)
  const [pinPreparing, setPinPreparing] = useState(false), [zoom, setZoom] = useState(Number(snapshot.options.magnifier_zoom ?? 4)), [colorFormat, setColorFormat] = useState(0), [effect, setEffect] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [playback, setPlayback] = useState<HTMLImageElement | null>(null)
  const stage = useRef<HTMLDivElement>(null), documentCanvas = useRef<HTMLCanvasElement>(null), chromeCanvas = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(true), busyRef = useRef(false), interactionQueue = useRef(Promise.resolve())
  const nudgeQueue = useRef(Promise.resolve())
  const originalTools = useMemo(() => structuredClone(scene.styles), [scene])
  const baseline = useMemo(() => ({ ...structuredClone(snapshot.tools), ...originalTools }), [snapshot, originalTools])
  const dismissing = useRef(false)
  const background = useMemo(() => { const c = canvas(snapshot.bounds.width, snapshot.bounds.height); context2d(c, true).drawImage(image, 0, 0); return c }, [snapshot, image])
  const scale = Number(snapshot.options.ui_scale_percent) / 100 || (window.devicePixelRatio > 1.5 ? 1.5 : window.devicePixelRatio > 1 ? 1.25 : 1)
  const live = (record !== null && record !== 'playback') || scroll
  const absolute = useCallback((): Rect => ({ ...(scene.selection ?? scene.bounds), x: (scene.selection?.x ?? 0) + snapshot.bounds.x, y: (scene.selection?.y ?? 0) + snapshot.bounds.y }), [scene, snapshot])
  const refresh = scene.onChange
  const cursorX = scene.cursor.x, cursorY = scene.cursor.y
  useEffect(() => {
    if (scene.confirmed || scene.drag || !snapshot.options.smart_selection || snapshot.options.smart_selection_mode !== 'element') return
    let disposed = false
    const timer = setTimeout(() => { void bridge.action<Rect | null>(snapshot.id, 'element_at', { value: { x: Math.round(cursorX + snapshot.bounds.x), y: Math.round(cursorY + snapshot.bounds.y) } }).then(rect => { if (!disposed && rect) scene.setHover({ ...rect, x: rect.x - snapshot.bounds.x, y: rect.y - snapshot.bounds.y }) }).catch(() => { /* Keep the window rectangle when the provider does not expose elements. */ }) }, 80)
    return () => { disposed = true; clearTimeout(timer) }
  }, [bridge, scene, snapshot, cursorX, cursorY])
  const refreshBackground = useCallback(async () => {
    const sessionActive = () => activeRef.current && !dismissing.current
    if (busyRef.current || dismissing.current) return
    busyRef.current = true
    try {
      const value = await bridge.action<{ image: string }>(snapshot.id, 'refresh')
      const next = new Image(); next.src = value.image; await next.decode()
      if (!sessionActive()) return
      context2d(background).drawImage(next, 0, 0); invalidateMosaic(background); scene.onChange()
      if (documentCanvas.current) drawDocument(context2d(documentCanvas.current), scene, background)
      // A hidden WebView can suspend rAF. Paint directly and bound the compositor
      // wait so refreshing can never strand an invisible capture window.
      await new Promise<void>(resolve => {
        let frame = 0
        const done = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve() }
        const timer = setTimeout(done, 60)
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done) })
      })
    } catch (e) { if (sessionActive()) setError(String(e)) }
    finally {
      if (sessionActive()) await bridge.ready(snapshot.id).catch((e: unknown) => setError(String(e)))
      busyRef.current = false
    }
  }, [background, bridge, scene, snapshot.id])
  const adjustZoom = useCallback((direction: number) => {
    const next = clamp(Number(scene.snapshot.options.magnifier_zoom ?? 4) + direction * 0.25, 1, 10)
    setZoom(next); scene.setOption('magnifier_zoom', next)
  }, [scene])
  const preferences = useCallback(() => capturePreferences(scene, baseline, scene.confirmed ? absolute() : undefined), [scene, baseline, absolute])
  // In-session choices take effect immediately; commit them together after withdrawing.
  const persist = useCallback(() => { /* saved by the terminal action */ }, [])
  useEffect(() => {
    scene.setCommit(persist)
    return () => { scene.setCommit(() => { /* detached */ }) }
  }, [scene, persist])
  const perform = useCallback(async (name: string, payload: CapturePayload = {}) => {
    if (busyRef.current || dismissing.current) return
    busyRef.current = true; setWorking(true); setError('')
    try {
      return await bridge.action(snapshot.id, name, { ...payload, ...(['copy', 'confirm', 'save', 'pin', 'copy_pin'].includes(name) ? { preferences: preferences() } : {}) })
    } catch (e) { setError(String(e)); return undefined } finally { busyRef.current = false; if (activeRef.current) setWorking(false) }
  }, [bridge, snapshot.id, preferences])
  const cancel = useCallback(() => {
    if (dismissing.current) return
    dismissing.current = true
    void bridge.action(snapshot.id, 'cancel', { preferences: preferences() }).catch((e: unknown) => { dismissing.current = false; setError(String(e)) })
  }, [bridge, snapshot.id, preferences])
  const finishScroll = useCallback(async (pin: boolean, save = false) => {
    const sessionActive = () => activeRef.current && !dismissing.current
    if (busyRef.current || !sessionActive()) return
    busyRef.current = true; setWorking(true)
    try {
      const result = await bridge.action<{ image: string; width: number; height: number }>(snapshot.id, 'scroll_finish')
      if (!sessionActive()) return
      const rect = { ...absolute(), width: result.width, height: result.height }
      await bridge.action(snapshot.id, save ? 'save' : pin ? 'pin' : 'confirm', { image: result.image, ...(pin ? { pinImage: result.image, value: [] } : {}), rect, preferences: preferences() })
    } catch (error) { if (sessionActive()) setError(String(error)) }
    finally { busyRef.current = false; if (activeRef.current) setWorking(false) }
  }, [absolute, bridge, snapshot.id, preferences])
  const action = useCallback((name: ToolAction) => {
    if (name === 'undo') { scene.undo(); return } if (name === 'redo') { scene.redo(); return } if (name === 'cancel') { cancel(); return }
    if (scroll && ['confirm', 'copy', 'save', 'pin'].includes(name)) { void finishScroll(name === 'pin', name === 'save'); return }
    scene.finishText()
    if (!scene.selection) return
    if (name === 'gif') { scene.setTool('cursor'); setRecord('ready'); return }
    if (['confirm', 'copy', 'save', 'pin'].includes(name)) {
      if (busyRef.current || dismissing.current) return
      busyRef.current = true
      // A pin keeps the selected pixels visible until its replacement window is
      // painted. Other terminal actions still withdraw before PNG encoding/I/O.
      void (async () => {
        try {
          let encoded: string
          if (name === 'pin') {
            // Native pixels must be visible before any composition change:
            // clip-path/SetWindowRgn can invalidate a protected WebView surface.
            encoded = exportSelection(scene, background).toDataURL()
            // Retain the complete visible selection, including both halves of
            // its centered border; file decorations remain an export concern.
            const retained = exportPinSelection(scene, background)
            await interactionQueue.current
            await bridge.action(snapshot.id, 'pin_prepare', { rect: absolute(), image: retained.image.toDataURL(), value: retained.frame })
            if (dismissing.current) return
            setPinPreparing(true)
            if (chromeCanvas.current) drawRetainedChrome(context2d(chromeCanvas.current), scene)
          } else { await bridge.action(snapshot.id, 'dismiss'); encoded = exportSelection(scene, background).toDataURL() }
          if (dismissing.current) return
          const r = scene.selection
          if (!r) throw new Error('截图选区已结束')
          const pinBase = name === 'pin' ? canvas(r.width, r.height) : null
          if (pinBase) context2d(pinBase).drawImage(background, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height)
          const marks = scene.marks.map(mark => ({ ...mark, points: mark.points.map(p => ({ x: p.x - r.x, y: p.y - r.y })) }))
          await bridge.action(snapshot.id, name, { image: encoded, ...(pinBase ? { pinImage: pinBase.toDataURL() } : {}), rect: absolute(), value: name === 'pin' ? marks : undefined, preferences: preferences() })
        } catch (e) {
          if (!dismissing.current) {
            if (name === 'pin') { await bridge.action(snapshot.id, 'pin_abort').catch(() => { /* superseded session */ }); setPinPreparing(false) }
            await bridge.ready(snapshot.id).catch(() => { /* superseded session */ }); setError(String(e))
          }
        } finally { busyRef.current = false }
      })()
      return
    }
    if (name === 'scan_code') {
      if (busyRef.current || dismissing.current) return
      busyRef.current = true
      void (async () => {
        try {
          await bridge.action(snapshot.id, 'dismiss')
          if (!dismissing.current) await bridge.action(snapshot.id, 'scan', { image: exportSelection(scene, background).toDataURL(), rect: absolute(), preferences: preferences() })
        } catch (e) { if (!dismissing.current) { await bridge.ready(snapshot.id).catch(() => { /* superseded session */ }); setError(String(e)) } }
        finally { busyRef.current = false }
      })()
      return
    }
    const result = exportSelection(scene, background).toDataURL()
    if (name === 'long_screenshot') { const r = scene.selection, base = canvas(r.width, r.height); context2d(base).drawImage(background, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height); void perform('scroll_start', { image: base.toDataURL(), rect: absolute() }).then(response => { if (response !== undefined) { scene.setTool('cursor', false); setScroll(true) } }); return }
    persist(); void perform(name, { image: result, rect: absolute() })
  }, [scene, background, bridge, snapshot.id, perform, absolute, persist, preferences, cancel, scroll, finishScroll])
  useEffect(() => {
    activeRef.current = true
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => { activeRef.current = false; window.removeEventListener('resize', resize) }
  }, [])
  useLayoutEffect(() => {
    const doc = documentCanvas.current?.getContext('2d'), chrome = chromeCanvas.current?.getContext('2d')
    if (!doc || !chrome) return
    if (pinPreparing) { drawRetainedChrome(chrome, scene); return }
    if (scroll) doc.clearRect(0, 0, scene.bounds.width, scene.bounds.height)
    else drawDocument(doc, scene, background, !record)
    if (record === 'playback' && playback && scene.selection) { const r = scene.selection; doc.drawImage(playback, r.x, r.y, r.width, r.height) }
    drawChrome(chrome, scene, !!record || scroll, effect === 'border', record, scroll)
  }, [revision, scene, background, record, scroll, playback, effect, pinPreparing])
  useEffect(() => {
    if (!scroll) return
    // scroll_start withdrew the frozen desktop. Show only after live canvases
    // have been cleared; a timeout also works when hidden WebView rAF is paused.
    const timer = setTimeout(() => {
      void interactionQueue.current.then(() => {
        if (activeRef.current && !dismissing.current) return bridge.ready(snapshot.id)
      }).catch((e: unknown) => setError(String(e)))
    }, 60)
    return () => clearTimeout(timer)
  }, [scroll, bridge, snapshot.id])
  useEffect(() => {
    const root = stage.current; if (!root) return
    let previous = '', disposed = false
    const mode = scroll ? 'scroll' : record === 'playback' ? 'playback' : record ? scene.tool === 'cursor' ? 'live' : 'draw' : 'capture'
    const update = (elements: Element[]) => {
      const regions = elements.map(element => {
        const r = element.getBoundingClientRect(), ratioX = snapshot.bounds.width / viewport.width, ratioY = snapshot.bounds.height / viewport.height
        return { x: Math.floor(r.x * ratioX) + snapshot.bounds.x - 4, y: Math.floor(r.y * ratioY) + snapshot.bounds.y - 4, width: Math.ceil(r.width * ratioX) + 8, height: Math.ceil(r.height * ratioY) + 8 }
      })
      const panels = regions.filter((_, index) => !elements[index]?.hasAttribute('data-capture-visible'))
      const visuals = regions.filter((_, index) => elements[index]?.hasAttribute('data-capture-visible'))
      const value = captureWindowRegions(snapshot.bounds, scene.selection ? absolute() : null, panels, mode, visuals)
      const signature = JSON.stringify(value); if (signature === previous) return; previous = signature
      interactionQueue.current = interactionQueue.current.then(async () => {
        if (!disposed && activeRef.current && !dismissing.current) await bridge.action(snapshot.id, 'interaction', { value })
      }).catch((e: unknown) => { if (!disposed && activeRef.current && !dismissing.current) setError(String(e)) })
    }
    const stop = observeInteractionRegions(document.body, '[data-capture-interactive], [data-capture-visible], .save-success-toast', update)
    return () => { disposed = true; stop() }
  }, [record, scroll, scene.tool, scene, absolute, bridge, snapshot, viewport])
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (busyRef.current) { if (e.key === 'Escape') { e.preventDefault(); cancel() } return }
      const editing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if (e.key === 'Escape') { e.preventDefault(); if (effect) setEffect(null); else cancel(); return }
      if (editing) { if (e.key === 'Enter' && e.ctrlKey && scene.textEditing) { scene.finishText(); e.preventDefault() } return }
      const control = e.ctrlKey || e.metaKey
      if (control && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) scene.redo(); else scene.undo(); return }
      if (control && e.key.toLowerCase() === 'y') { e.preventDefault(); scene.redo(); return }
      if (control && e.key.toLowerCase() === 's') { e.preventDefault(); action('save'); return }
      if (control && e.key.toLowerCase() === 'c' && scene.confirmed) { e.preventDefault(); action('confirm'); return }
      if (e.key === 'Enter' && scene.confirmed && !record && !e.repeat) { e.preventDefault(); action('confirm'); return }
      if (e.key === 'Delete') { scene.deleteSelected(); return }
      if (scene.tool === 'cursor') {
        if (e.key === 'Shift' && !e.repeat) setColorFormat(v => v + 1)
        if (e.key.toLowerCase() === 'c' && !control) { const color = pixelColor(background, scene.cursor, snapshot.options.magnifier_color_formats, colorFormat); void perform('copy_text', { value: color.value }).then(value => { if (value !== undefined) cancel() }); return }
        if (e.key === 'PageUp' || e.key === '+' || e.key === '=') adjustZoom(1)
        if (e.key === 'PageDown' || e.key === '-') adjustZoom(-1)
        const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1] } as Record<string, [number, number]>)[e.key]
        if (direction && !control && !e.altKey && !live && !record && (!scene.confirmed || e.key.startsWith('Arrow'))) {
          e.preventDefault()
          // Physical single-pixel moves may produce no WebView pointer event at
          // fractional DPI. Apply the returned native position explicitly, in order.
          nudgeQueue.current = nudgeQueue.current.then(async () => {
            const sessionActive = () => activeRef.current && !dismissing.current
            if (!sessionActive()) return
            const p = await bridge.action<Point>(snapshot.id, 'nudge', { value: { x: direction[0], y: direction[1] } })
            if (sessionActive()) scene.move({ x: p.x - snapshot.bounds.x, y: p.y - snapshot.bounds.y }, false)
          }).catch((e: unknown) => { if (activeRef.current && !dismissing.current) setError(String(e)) })
          return
        }
      }
      if (e.key.toLowerCase() === 'l' && snapshot.tools.lastRegion && scene.tool === 'cursor') { e.preventDefault(); const r = snapshot.tools.lastRegion; const local = { ...r, x: r.x - snapshot.bounds.x, y: r.y - snapshot.bounds.y }; if (contains(scene.bounds, local) && contains(scene.bounds, { x: local.x + local.width, y: local.y + local.height })) scene.presetSelection(local) }
      if (scene.confirmed && !control && !e.altKey && !e.repeat) {
        const tools: Record<string, Tool> = { s: 'cursor', p: 'pen', x: 'mosaic', a: 'arrow', n: 'number', r: 'rect', o: 'ellipse', t: 'text', e: 'eraser' }
        const tool = tools[e.key.toLowerCase()]; if (tool) { e.preventDefault(); scene.setTool(tool, false) }
      }
    }
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys)
  }, [action, adjustZoom, background, bridge, cancel, colorFormat, effect, live, perform, record, refresh, scene, scroll, snapshot])
  const nativePixels = isTauriRuntime()
  const point = (e: PointerEvent): Point => ({ x: e.clientX * (nativePixels ? window.devicePixelRatio : snapshot.bounds.width / viewport.width), y: e.clientY * (nativePixels ? window.devicePixelRatio : snapshot.bounds.height / viewport.height) })
  const down = (e: PointerEvent<HTMLCanvasElement>) => { if (e.button === 1 && scene.confirmed && !record && !scroll) { e.preventDefault(); action('pin'); return } if (e.button !== 0 || working || record === 'playback' || (record && scene.tool === 'cursor') || scroll) return; e.currentTarget.setPointerCapture(e.pointerId); scene.down(point(e), e.ctrlKey) }
  const up = (e: PointerEvent<HTMLCanvasElement>) => { if (e.button !== 0) return; const wasConfirmed = scene.confirmed; scene.up(); if (!wasConfirmed && scene.confirmed) { persist(); if (snapshot.mode === 'record') setRecord('ready'); if (snapshot.mode === 'scan') action('scan_code') } }
  const rightClick = cancel
  const region = scene.selection ?? scene.hover
  const renderScale = nativePixels ? 1 / window.devicePixelRatio : viewport.width / snapshot.bounds.width
  // Give each canvas its actual CSS-pixel size and cancel the physical stage's
  // transform. One bitmap pixel then maps to one desktop pixel at fractional DPI.
  const bitmapStyle: CSSProperties = nativePixels ? { width: snapshot.bounds.width, height: snapshot.bounds.height, imageRendering: 'pixelated' } : { width: snapshot.bounds.width * renderScale, height: snapshot.bounds.height * renderScale, transform: `scale(${1 / renderScale})`, transformOrigin: '0 0', imageRendering: 'pixelated' }
  const retainedPadding = framePadding(selectionFrame(scene))
  const clipSelection = (padding: number) => scene.selection ? `inset(${Math.max(0, scene.selection.y - padding)}px ${Math.max(0, scene.bounds.width - scene.selection.x - scene.selection.width - padding)}px ${Math.max(0, scene.bounds.height - scene.selection.y - scene.selection.height - padding)}px ${Math.max(0, scene.selection.x - padding)}px)` : undefined
  const textMark = scene.textEditing ? scene.marks.find(m => m.id === scene.textEditing) : null
  return <div className="jt-surface" ref={stage} onContextMenu={e => e.preventDefault()}>
    <div className="jt-physical-stage" data-pin-preparing={pinPreparing || undefined} data-native-pixels={isTauriRuntime() || undefined} style={{ width: snapshot.bounds.width, height: snapshot.bounds.height, transform: `scale(${renderScale})`, clipPath: pinPreparing ? clipSelection(retainedPadding) : undefined, '--jt-accent': String(snapshot.options.theme_color) } as CSSProperties}>
      <div className="jt-document-clip" style={{ clipPath: pinPreparing ? clipSelection(0) : undefined }}><canvas ref={documentCanvas} width={snapshot.bounds.width} height={snapshot.bounds.height} className="jt-document" style={bitmapStyle} /></div>
      <canvas ref={chromeCanvas} width={snapshot.bounds.width} height={snapshot.bounds.height} className="jt-chrome" style={{ ...bitmapStyle, cursor: !record && !scroll ? scene.pointerCursor : scene.tool === 'text' ? 'text' : 'crosshair' }}
        onPointerDown={e => { if (!busyRef.current) down(e) }} onPointerMove={e => { if (!busyRef.current) { scene.move(point(e), e.shiftKey); if (!record && !scroll) e.currentTarget.style.cursor = scene.pointerCursor } }} onPointerUp={up} onPointerCancel={() => scene.up()} onContextMenu={e => { e.preventDefault(); rightClick() }}
        onDoubleClick={() => { if (scene.confirmed && !scene.textEditing && !scene.active && !record && !scroll) action('confirm'); else if (scene.active?.tool === 'text') { scene.editText(scene.active.id) } }}
        onWheel={e => {
          if (!e.deltaY || working || busyRef.current || dismissing.current) return
          const direction = e.deltaY < 0 ? 1 : -1
          if (scene.tool === 'number' && e.shiftKey) scene.setNextNumber(clamp(scene.nextNumber + direction, 1, 999))
          else if (scene.tool !== 'cursor') scene.setStyle({ width: clamp(scene.style.width + direction, 1, 200) })
          else if (!live && !record && !scene.selected && snapshot.options.magnifier_enabled) adjustZoom(direction)
        }} />
      {!pinPreparing && <>
      {region && !live && !record && <SelectionInfo scene={scene} rect={region} scale={scale} effect={effect} setEffect={setEffect} refresh={refreshBackground} />}
      {scene.confirmed && !scene.drag && !record && !scroll && <CaptureToolbar scene={scene} scale={scale} action={action} persist={persist} busy={working} />}
      {!live && !record && scene.tool === 'cursor' && !scene.selected && snapshot.options.magnifier_enabled && <Magnifier scene={scene} background={background} zoom={zoom} format={colorFormat} revision={revision} scale={scale} />}
      {textMark && <textarea className="jt-text-editor" aria-label="标注文字" autoFocus data-capture-interactive value={textMark.text} style={{ left: textMark.points[0].x, top: textMark.points[0].y, fontSize: textMark.style.fontSize * 96 / 72, fontWeight: textMark.style.bold ? 700 : 400, fontStyle: textMark.style.italic ? 'italic' : 'normal', textDecoration: textMark.style.underline ? 'underline' : 'none', fontFamily: textMark.style.font, color: textMark.style.color, minWidth: Math.max(180, markBounds(textMark).width + 24), height: Math.max(60, markBounds(textMark).height + 20) }} onChange={e => { scene.editText(textMark.id, e.target.value) }} onBlur={() => scene.finishText()} />}
      {record && scene.selection && <RecordingControls scene={scene} bridge={bridge} state={record} setState={setRecord} scale={scale} setFrame={setPlayback} error={setError} cancel={cancel} />}
      {scroll && <ScrollControls scene={scene} bridge={bridge} scale={scale} cancel={cancel} finish={finishScroll} error={setError} />}
      {error ? <CaptureNotice snapshot={snapshot} message={error} tone="error" onDismiss={() => setError('')}><button type="button" onClick={cancel}>退出截图</button></CaptureNotice>
        : working && <CaptureNotice snapshot={snapshot} message="正在处理…" />}
      </>}
    </div>
  </div>
}
export function QuickCaptureSurface() {
  const [drag, setDrag] = useState<{ start: [number, number]; end: [number, number]; bounds: Rect } | null>(null)
  useEffect(() => { let disposed = false, stop: (() => void) | undefined; void listen<{ start: [number, number]; end: [number, number]; bounds: Rect }>('capture:quick', e => setDrag(e.payload)).then(unlisten => { if (disposed) unlisten(); else stop = unlisten }); return () => { disposed = true; stop?.() } }, [])
  if (!drag) return <div className="jt-surface" />
  const ratio = window.innerWidth / drag.bounds.width, x = (Math.min(drag.start[0], drag.end[0]) - drag.bounds.x) * ratio, y = (Math.min(drag.start[1], drag.end[1]) - drag.bounds.y) * ratio, width = Math.abs(drag.start[0] - drag.end[0]), height = Math.abs(drag.start[1] - drag.end[1])
  return <div className="jt-surface jt-quick"><div style={{ left: x, top: y, width: width * ratio, height: height * ratio }}><span>{width} × {height}</span></div></div>
}
export function CaptureRoot() {
  const label = isTauriRuntime() ? getCurrentWindow().label : new URLSearchParams(location.search).get('window')
  const [session, setSession] = useState<{ snapshot: CaptureSnapshot; image: HTMLImageElement } | null>(null)
  useEffect(() => {
    if (label === 'capture-quick') return
    let disposed = false, stop: (() => void) | undefined, generation = 0
    const load = async () => {
      const token = ++generation
      let id: string | undefined
      try {
        const snapshot = await captureBridge.snapshot(), image = new Image(); id = snapshot.id; image.src = snapshot.image; await image.decode()
        if (disposed || token !== generation) return
        setSession({ snapshot, image })
        // PinSurface owns its readiness: canvas paint and native geometry must
        // both complete before the capture-to-pin window handoff.
        if (snapshot.mode !== 'pin') requestAnimationFrame(() => requestAnimationFrame(() => { if (!disposed && token === generation) void captureBridge.ready(snapshot.id).catch(() => { /* a superseded session stays hidden */ }) }))
      } catch {
        // No snapshot is expected during prewarming; a failed active image is different.
        if (id && !disposed && token === generation) { setSession(null); void captureBridge.action(id, 'load_failed').catch(() => { /* the native load watchdog also releases the session */ }) }
      }
    }
    void captureBridge.session(() => void load()).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; void load() } })
    return () => { disposed = true; stop?.() }
  }, [label])
  if (label === 'capture-quick') return <QuickCaptureSurface />
  return session ? <CaptureRenderBoundary key={session.snapshot.id} id={session.snapshot.id}>{session.snapshot.mode === 'pin' ? <PinSurface {...session} /> : <CaptureSurface {...session} />}</CaptureRenderBoundary> : <div className="jt-surface" />
}
