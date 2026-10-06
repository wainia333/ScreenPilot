import { handles, markBounds, rectBetween, textFont, textPixels } from './model'
import { arrowGeometry } from './arrow-geometry'
import type { Mark, Point, Rect, SelectionFrame } from './model'
import type { CaptureScene } from './scene'
import { reduceMosaic } from './mosaic'
type Context = CanvasRenderingContext2D
export function context2d(value: HTMLCanvasElement, frequent = false): Context { const context = value.getContext('2d', { willReadFrequently: frequent }); if (!context) throw new Error('无法创建绘图画布'); return context }
export function canvas(width: number, height: number) { const value = document.createElement('canvas'); value.width = Math.max(1, Math.round(width)); value.height = Math.max(1, Math.round(height)); return value }
const mosaicCache = new WeakMap<CanvasImageSource, Map<number, HTMLCanvasElement>>()
export function invalidateMosaic(background: CanvasImageSource) { mosaicCache.delete(background) }
function mosaicTexture(background: CanvasImageSource, block: number) {
  let entries = mosaicCache.get(background); if (!entries) { entries = new Map(); mosaicCache.set(background, entries) }
  const cached = entries.get(block); if (cached) return cached
  const size = background as HTMLCanvasElement, source = canvas(size.width, size.height), c = context2d(source, true); c.drawImage(background, 0, 0)
  const reduced = reduceMosaic(c.getImageData(0, 0, source.width, source.height).data, source.width, source.height, block), result = canvas(reduced.width, reduced.height)
  context2d(result).putImageData(new ImageData(reduced.data, reduced.width, reduced.height), 0, 0)
  entries.set(block, result); return result
}
function path(points: Point[]) { const p = new Path2D(); points.forEach((point, i) => { if (i === 0) p.moveTo(point.x, point.y); else p.lineTo(point.x, point.y) }); return p }
function arrow(ctx: Context, mark: Mark) {
  const geometry = arrowGeometry(mark), silhouette = new Path2D()
  for (const ring of geometry.rings) { const part = path(ring); part.closePath(); silhouette.addPath(part) }
  if (mark.style.arrow === 'hollow') {
    ctx.save(); ctx.clip(silhouette, 'evenodd'); ctx.lineWidth = geometry.outline * 2; ctx.lineJoin = 'miter'; ctx.miterLimit = 8; ctx.stroke(silhouette); ctx.restore()
  } else ctx.fill(silhouette, 'evenodd')
}
export function drawMark(ctx: Context, mark: Mark, background: CanvasImageSource) {
  const { style: s, tool } = mark, r = markBounds(mark)
  ctx.save(); ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width; ctx.globalAlpha = s.opacity; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  if (mark.rotation) { ctx.translate(r.x + r.width / 2, r.y + r.height / 2); ctx.rotate(mark.rotation); ctx.translate(-r.x - r.width / 2, -r.y - r.height / 2) }
  ctx.setLineDash(s.line === 'solid' ? [] : s.line === 'dashed' ? [s.width * 3, s.width * 2] : [s.width, s.width * 2])
  if (tool === 'pen') {
    if (s.mode === 'rect') ctx.fillRect(r.x, r.y, r.width, r.height)
    else { const p = path(mark.points); if (mark.points.length <= 2 && r.width + r.height < 1) { ctx.beginPath(); ctx.arc(r.x, r.y, s.width / 2, 0, Math.PI * 2); ctx.fill() } else ctx.stroke(p) }
  } else if (tool === 'rect' || tool === 'ellipse') {
    ctx.beginPath()
    if (tool === 'rect') ctx.roundRect(r.x, r.y, r.width, r.height, Math.min(s.radius, r.width / 2, r.height / 2))
    else ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, Math.max(0.1, r.width / 2), Math.max(0.1, r.height / 2), 0, 0, Math.PI * 2)
    if (s.fill) ctx.fill(); else ctx.stroke()
  } else if (tool === 'arrow') arrow(ctx, mark)
  else if (tool === 'text') {
    const size = textPixels(s), lines = (mark.text ?? '').split('\n'), lineHeight = size * 1.35
    ctx.font = textFont(s); ctx.textBaseline = 'top'; ctx.translate(3,3)
    const width = Math.max(1, ...lines.map(line => ctx.measureText(line).width))
    if (s.background) { ctx.fillStyle = s.backgroundColor; ctx.beginPath(); ctx.roundRect(r.x - 3, r.y - 3, width + 6, lines.length * lineHeight + 6, 3); ctx.fill(); ctx.fillStyle = s.color }
    if (s.shadow) { ctx.shadowColor = s.shadowColor; ctx.shadowOffsetX = s.fontSize * 0.08; ctx.shadowOffsetY = s.fontSize * 0.08; ctx.shadowBlur = 0 }
    for (const [i, line] of lines.entries()) {
      if (s.outline) { ctx.strokeStyle = s.outlineColor; ctx.lineWidth = s.fontSize * s.outlineWidth * 2; ctx.strokeText(line, r.x, r.y + i * lineHeight) }
      ctx.fillText(line, r.x, r.y + i * lineHeight)
      if (s.underline) { ctx.fillRect(r.x, r.y + i * lineHeight + size, ctx.measureText(line).width, Math.max(1, size / 16)) }
    }
  } else if (tool === 'number') {
    const p = mark.points[0], radius = Math.max(8, s.width)
    ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    if (s.number !== 'hollow_all' && s.number !== 'no_circle') { ctx.fillStyle = s.number === 'solid' ? s.color : '#FFFFFF'; ctx.fill() }
    if (s.number !== 'solid' && s.number !== 'no_circle') { ctx.lineWidth = Math.max(1, radius / 6); ctx.stroke() }
    ctx.fillStyle = s.number === 'solid' ? '#FFFFFF' : s.color; ctx.font = `bold ${radius * 1.25}px "Microsoft YaHei UI"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(mark.number), p.x, p.y)
  } else if (tool === 'mosaic') {
    const margin = s.mode === 'rect' ? 0 : s.width / 2
    const region = { x: Math.floor(r.x - margin), y: Math.floor(r.y - margin), width: Math.ceil(r.width + margin * 2), height: Math.ceil(r.height + margin * 2) }
    if (region.width > 0 && region.height > 0) {
      const texture = mosaicTexture(background, s.block), pattern = ctx.createPattern(texture, 'repeat')
      if (pattern) {
        pattern.setTransform(new DOMMatrix().translate(-s.block, -s.block).scale(s.block)); ctx.imageSmoothingEnabled = s.mosaic === 'blur'; ctx.fillStyle = pattern; ctx.strokeStyle = pattern; ctx.setLineDash([])
        if (s.mode === 'rect') ctx.fillRect(r.x, r.y, r.width, r.height)
        else if (r.width + r.height < 1) { ctx.beginPath(); ctx.arc(r.x, r.y, s.width / 2, 0, Math.PI * 2); ctx.fill() }
        else ctx.stroke(path(mark.points))
      }
    }
  }
  ctx.restore()
}
export function drawDocument(ctx: Context, scene: CaptureScene, background: CanvasImageSource, backgroundVisible = true) {
  const { width, height } = scene.bounds
  ctx.clearRect(0, 0, width, height)
  if (backgroundVisible) ctx.drawImage(background, 0, 0, width, height)
  ctx.save()
  if (scene.selection) { const r = scene.selection; ctx.beginPath(); ctx.rect(r.x, r.y, r.width, r.height); ctx.clip() }
  let marks = scene.marks
  if (scene.snapshot.options.text_always_on_top) marks = [...marks.filter(m => m.tool !== 'text'), ...marks.filter(m => m.tool === 'text')]
  for (const mark of marks) if (mark.id !== scene.textEditing && mark.tool !== 'spotlight') drawMark(ctx, mark, background)
  const spots = marks.filter(m => m.tool === 'spotlight')
  if (spots.length) {
    const curtain = canvas(width, height), c = context2d(curtain)
    c.fillStyle = `rgba(0,0,0,${(spots.at(-1)?.style.opacity ?? 0.7)})`; c.fillRect(0, 0, width, height); c.globalCompositeOperation = 'destination-out'
    for (const spot of spots) { const r = markBounds(spot); c.fillRect(r.x, r.y, r.width, r.height) }
    ctx.drawImage(curtain, 0, 0)
  }
  ctx.restore()
}
// selection_info/border_shadow.py: the original uses layered rings, not a blur.
function drawImageEdge(ctx: Context, rect: Rect, options: CaptureScene['snapshot']['options'], preview = false) {
  const size = Number(options.screenshot_border_size), radius = options.screenshot_rounded_enabled ? Number(options.screenshot_rounded_radius) : 0
  const border = options.screenshot_border_mode === 'border'
  ctx.save(); ctx.strokeStyle = String(options[border ? 'screenshot_border_color' : 'screenshot_shadow_color']); ctx.lineJoin = 'miter'
  const ring = (spread: number) => { ctx.beginPath(); ctx.roundRect(rect.x - spread, rect.y - spread, rect.width + spread * 2, rect.height + spread * 2, radius ? Math.min(radius, rect.width / 2, rect.height / 2) + spread : 0); ctx.stroke() }
  if (border) { ctx.lineWidth = size; ring(size / 2) }
  else { const layers = Math.min(size, preview ? 20 : 25); ctx.lineWidth = 1.5; for (let i = 0; i < layers; i++) { const t = (i + 1) / layers; ctx.globalAlpha = Math.floor((preview ? 120 * 0.6 : 180 * 0.5) * (1 - t)) / 255; ring(Math.floor(size * t)) } }
  ctx.restore()
}
export function selectionFrame(scene: CaptureScene): SelectionFrame {
  return { width: Number(scene.snapshot.options.selection_border_width ?? 4), color: String(scene.snapshot.options.theme_color ?? '#3388ff'), radius: scene.snapshot.options.screenshot_rounded_enabled ? Number(scene.snapshot.options.screenshot_rounded_radius) : 0 }
}
export function framePadding(frame: SelectionFrame) { return Math.ceil(frame.width / 2) + 1 }
export function drawSelectionFrame(ctx: Context, rect: Rect, frame: SelectionFrame) {
  ctx.save(); ctx.strokeStyle = frame.color; ctx.lineWidth = frame.width
  ctx.beginPath(); ctx.roundRect(rect.x, rect.y, rect.width, rect.height, Math.min(frame.radius, rect.width / 2, rect.height / 2)); ctx.stroke(); ctx.restore()
}
export function drawRetainedChrome(ctx: Context, scene: CaptureScene) {
  ctx.clearRect(0, 0, scene.bounds.width, scene.bounds.height)
  if (scene.selection) drawSelectionFrame(ctx, scene.selection, selectionFrame(scene))
}
export function exportPinSelection(scene: CaptureScene, background: CanvasImageSource) {
  const r = scene.selection ?? scene.bounds, frame = selectionFrame(scene), padding = framePadding(frame)
  const result = canvas(r.width + padding * 2, r.height + padding * 2), ctx = context2d(result)
  ctx.save(); ctx.beginPath(); ctx.roundRect(padding, padding, r.width, r.height, Math.min(frame.radius, r.width / 2, r.height / 2)); ctx.clip()
  ctx.drawImage(exportSelection(scene, background, false, false), padding, padding); ctx.restore()
  drawSelectionFrame(ctx, { x: padding, y: padding, width: r.width, height: r.height }, frame)
  return { image: result, frame, padding }
}
export function drawChrome(ctx: Context, scene: CaptureScene, live: boolean, previewEdge = false, recording?: 'ready' | 'recording' | 'paused' | 'playback' | null, scrolling = false) {
  const { width, height } = scene.bounds, r = scene.selection ?? scene.previewHover, options = scene.snapshot.options, accent = recording ? recording === 'recording' || recording === 'paused' ? '#F44336' : '#2196F3' : String(options.theme_color ?? '#3388ff')
  ctx.clearRect(0, 0, width, height)
  if (!live) {
    ctx.fillStyle = 'rgba(0,0,0,0.470588)'; ctx.beginPath(); ctx.rect(0, 0, width, height)
    if (r) ctx.roundRect(r.x, r.y, r.width, r.height, options.screenshot_rounded_enabled ? Math.min(Number(options.screenshot_rounded_radius), r.width / 2, r.height / 2) : 0)
    ctx.fill('evenodd')
  }
  if (r) {
    ctx.strokeStyle = accent; ctx.lineWidth = recording ? 3 : Number(options.selection_border_width ?? 4)
    const radius = !recording && !scrolling && options.screenshot_rounded_enabled ? Math.min(Number(options.screenshot_rounded_radius), r.width / 2, r.height / 2) : 0
    const outside = scrolling ? ctx.lineWidth / 2 : 0
    ctx.beginPath(); ctx.roundRect(r.x - outside, r.y - outside, r.width + outside * 2, r.height + outside * 2, radius); ctx.stroke()
    if (!live && previewEdge && options.screenshot_border_enabled) drawImageEdge(ctx, r, options, true)
    if (scene.confirmed && !scene.drag && !live) {
      const size = ({ small: 10, medium: 14, large: 18 }[String(options.selection_handle_size)] ?? 10)
      const ring = ({ small: 2, medium: 3, large: 4 }[String(options.selection_handle_size)] ?? 2)
      const crowded = (size + 2 + ring) * (options.selection_handle_style === 'corners' ? 1 : 2) > Math.min(r.width, r.height) * 0.8
      for (const [i, p] of handles(r).entries()) {
        if (crowded || options.selection_handle_style === 'none' || (options.selection_handle_style === 'corners' && i % 2) || (radius > 0 && i % 2 === 0)) continue
        ctx.beginPath(); ctx.arc(p.x, p.y, size / 2 + 1, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = ring; ctx.stroke()
      }
    }
  }
  if (!scene.confirmed && options.capture_fullscreen_crosshair) { ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(scene.cursor.x, 0); ctx.lineTo(scene.cursor.x, height); ctx.moveTo(0, scene.cursor.y); ctx.lineTo(width, scene.cursor.y); ctx.stroke() }
  if (scene.tool === 'eraser' || scene.tool === 'mosaic') { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(scene.cursor.x, scene.cursor.y, scene.style.width / 2, 0, Math.PI * 2); ctx.stroke() }
}
export function exportSelection(scene: CaptureScene, background: CanvasImageSource, transparent = false, decorate = true) {
  const full = canvas(scene.bounds.width, scene.bounds.height); drawDocument(context2d(full), scene, background, !transparent)
  const r = scene.selection ?? scene.bounds, result = canvas(r.width, r.height), c = context2d(result)
  const options = scene.snapshot.options
  if (decorate && !transparent && options.screenshot_rounded_enabled) { c.beginPath(); c.roundRect(0, 0, result.width, result.height, Math.min(Number(options.screenshot_rounded_radius), result.width / 2, result.height / 2)); c.clip() }
  c.drawImage(full, r.x, r.y, r.width, r.height, 0, 0, result.width, result.height)
  if (decorate && !transparent && options.screenshot_border_enabled) {
    const pad = Number(options.screenshot_border_size)
    const decorated = canvas(result.width + pad * 2, result.height + pad * 2), context = context2d(decorated)
    drawImageEdge(context, { x: pad, y: pad, width: result.width, height: result.height }, options)
    context.drawImage(result, pad, pad); return decorated
  }
  return result
}
export function selectionFromPoints(a: Point, b: Point): Rect { return rectBetween(a, b) }
