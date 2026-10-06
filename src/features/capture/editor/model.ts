// Capture interaction geometry and defaults.
// All document coordinates are physical pixels, independent of WebView DPI.
import { arrowGeometry, arrowContains } from './arrow-geometry'
export type Point = { x: number; y: number }
export type Rect = Point & { width: number; height: number }
export type Tool = 'cursor' | 'pen' | 'mosaic' | 'spotlight' | 'arrow' | 'number' | 'rect' | 'ellipse' | 'text' | 'eraser'
export type Style = {
  color: string; width: number; opacity: number; line: 'solid' | 'dashed' | 'dashed_dense'
  fill: boolean; radius: number; arrow: string; mosaic: 'pixelate' | 'blur'; block: number
  mode: 'freehand' | 'rect'; number: 'solid' | 'hollow_bg' | 'hollow_all' | 'no_circle'
  font: string; fontSize: number; bold: boolean; italic: boolean; underline: boolean
  background: boolean; backgroundColor: string; outline: boolean; outlineColor: string; outlineWidth: number
  shadow: boolean; shadowColor: string
}
export type Mark = { id: string; tool: Exclude<Tool, 'cursor' | 'eraser'>; points: [Point, Point, ...Point[]]; style: Style; text?: string; number?: number; rotation: number }
export type SelectionFrame = { width: number; color: string; radius: number }
export type PinState = { view: { zoom: number; rotation: number; flipH: boolean; flipV: boolean }; crop: { rect: Rect; scale: number } | null; opacity: number; toolbar: boolean; marks: Mark[] | null; offset: Point; frame?: SelectionFrame | null }
export type CaptureSnapshot = {
  id: string; mode: 'image' | 'record' | 'scan' | 'pin' | 'scan-result'; bounds: Rect; screens: Rect[]; image: string
  options: Record<string, boolean | number | string>; tools: Partial<Record<Tool, Partial<Style>>> & { layout?: LayoutEntry[]; lastRegion?: Rect }
  windows: (Rect & { id: number; title: string; owner: string })[]; selection: Rect | null
  marks?: Mark[] | null
  pinState?: PinState | null
  scanResults?: { text: string; format: string }[] | null
  scanError?: string | null
}
export const toolOrder = ['long_screenshot', 'scan_code', 'gif', 'spotlight', 'pen', 'mosaic', 'arrow', 'number', 'shape', 'text', 'eraser', 'undo', 'redo', 'cancel', 'pin', 'save', 'confirm'] as const
// Legacy layout keys remain readable; drawing tools/styles still use rect/ellipse.
export type ToolAction = typeof toolOrder[number] | 'copy' | 'rect' | 'ellipse'
export type LayoutEntry = { key: ToolAction; mode: 'show' | 'more' | 'hide' }
export const defaultLayout: LayoutEntry[] = toolOrder.map(key => ({ key, mode: key === 'scan_code' ? 'more' : 'show' }))
export function normalizeLayout(entries: LayoutEntry[] | undefined): LayoutEntry[] {
  const seen = new Set<string>()
  const result: LayoutEntry[] = []
  const explicitShape = entries?.some(entry => entry.key === 'shape')
  for (const entry of entries ?? []) {
    const legacyShape = entry.key === 'rect' || entry.key === 'ellipse'
    if (legacyShape && explicitShape) continue
    const key = legacyShape ? 'shape' : entry.key
    if (!toolOrder.includes(key as typeof toolOrder[number])) continue
    const mode = key === 'confirm' || key === 'save' ? 'show' : ['show', 'more', 'hide'].includes(entry.mode) ? entry.mode : 'show'
    if (seen.has(key)) {
      // Keep either previously visible shape accessible when combining old layouts.
      const previous = legacyShape ? result.find(item => item.key === key) : undefined
      const priority = { show: 2, more: 1, hide: 0 }
      if (previous && priority[mode] > priority[previous.mode]) previous.mode = mode
      continue
    }
    seen.add(key); result.push({ key, mode })
  }
  const complete = [...result, ...defaultLayout.filter(entry => !seen.has(entry.key))]
  const gifIndex = complete.findIndex(entry => entry.key === 'gif')
  const spotlight = complete.find(entry => entry.key === 'spotlight')
  const ordered = complete.filter(entry => entry.key !== 'spotlight' && entry.key !== 'save' && entry.key !== 'confirm')
  // Migrate the old overflow placement; later visibility choices remain editable.
  ordered.splice(ordered.findIndex(entry => entry.key === 'gif') + 1, 0, { key: 'spotlight', mode: complete[gifIndex + 1]?.key === 'spotlight' ? spotlight?.mode ?? 'show' : 'show' })
  return [...ordered, { key: 'save', mode: 'show' }, { key: 'confirm', mode: 'show' }]
}
const baseStyle: Style = { color: '#FF0000', width: 9, opacity: 1, line: 'solid', fill: false, radius: 0, arrow: 'single', mosaic: 'pixelate', block: 10, mode: 'freehand', number: 'solid', font: 'Microsoft YaHei UI', fontSize: 14, bold: false, italic: false, underline: false, background: false, backgroundColor: '#FFFFFF', outline: false, outlineColor: '#FFFFFF', outlineWidth: 0.07, shadow: false, shadowColor: '#00000066' }
export function defaultStyle(tool: Tool): Style {
  const overrides: Partial<Record<Tool, Partial<Style>>> = { pen: { width: 12 }, mosaic: { width: 30, color: '#808080' }, spotlight: { opacity: 0.7 }, text: { color: '#000000' }, number: { width: 12, fontSize: 10 }, eraser: { width: 25 } }
  return { ...baseStyle, ...overrides[tool] }
}
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
export const contains = (r: Rect, p: Point, margin = 0) => p.x >= r.x - margin && p.y >= r.y - margin && p.x <= r.x + r.width + margin && p.y <= r.y + r.height + margin
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export function rectBetween(a: Point, b: Point, square = false): Rect {
  let dx = b.x - a.x, dy = b.y - a.y
  if (square) { const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size }
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), width: Math.abs(dx), height: Math.abs(dy) }
}
export function clipRect(r: Rect, bounds: Rect): Rect {
  const x = clamp(r.x, bounds.x, bounds.x + bounds.width), y = clamp(r.y, bounds.y, bounds.y + bounds.height)
  return { x, y, width: Math.max(0, Math.min(r.x + r.width, bounds.x + bounds.width) - x), height: Math.max(0, Math.min(r.y + r.height, bounds.y + bounds.height) - y) }
}
export function handles(rect: Rect): Point[] {
  const { x, y, width: w, height: h } = rect
  return [{ x, y }, { x: x + w / 2, y }, { x: x + w, y }, { x: x + w, y: y + h / 2 }, { x: x + w, y: y + h }, { x: x + w / 2, y: y + h }, { x, y: y + h }, { x, y: y + h / 2 }]
}
// Corners win where edge hit areas overlap. The whole edge can be resized,
// independently of whether its midpoint handle is visible.
export function selectionResizeHandle(r: Rect, p: Point, tolerance = 8): number {
  const left = Math.abs(p.x - r.x) <= tolerance, right = Math.abs(p.x - r.x - r.width) <= tolerance
  const top = Math.abs(p.y - r.y) <= tolerance, bottom = Math.abs(p.y - r.y - r.height) <= tolerance
  if (top && left) return 0
  if (top && right) return 2
  if (bottom && right) return 4
  if (bottom && left) return 6
  if (p.x >= r.x && p.x <= r.x + r.width) { if (top) return 1; if (bottom) return 5 }
  if (p.y >= r.y && p.y <= r.y + r.height) { if (right) return 3; if (left) return 7 }
  return -1
}
export function selectionResizeCursor(handle: number) {
  return ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][handle] ?? 'crosshair'
}
export function resizeRect(r: Rect, handle: number, point: Point): Rect {
  const opposite = handles(r)[(handle + 4) % 8] ?? { x: r.x, y: r.y }
  if (handle % 2 === 0) return rectBetween(opposite, point)
  if (handle === 1 || handle === 5) return rectBetween({ x: r.x, y: opposite.y }, { x: r.x + r.width, y: point.y })
  return rectBetween({ x: opposite.x, y: r.y }, { x: point.x, y: r.y + r.height })
}
export function toolbarPosition(selection: Rect, screen: Rect, width: number, scale: number, panelHeight = 50) {
  // toolbar.py::position_near_rect: align Confirm's right edge, not More's edge.
  const height = 40 * scale, extra = panelHeight * scale + 5 * scale
  let y = selection.y + selection.height + 10 * scale
  const below = y + height + extra <= screen.y + screen.height - 1
  if (!below) y = selection.y - height - 10 * scale
  return { x: clamp(selection.x + selection.width - 1 - width + Math.round(12.8 * scale) + 4 * scale, screen.x, screen.x + screen.width - width), y: clamp(y, screen.y, screen.y + screen.height - height), below }
}
export function screenFor(r: Rect, screens: Rect[]): Rect | undefined { return screens.find(s => contains(s, { x: r.x + r.width / 2, y: r.y + r.height / 2 })) ?? screens[0] }
export const textPixels = (style: Style) => style.fontSize * 96 / 72
export const textFont = (style: Style) => `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${textPixels(style)}px "${style.font}"`
let textMeasure: CanvasRenderingContext2D | null = null
function textWidth(mark: Mark) {
  if (!textMeasure && typeof CanvasRenderingContext2D !== 'undefined') textMeasure = document.createElement('canvas').getContext('2d')
  if (textMeasure) textMeasure.font = textFont(mark.style)
  return Math.max(1, ...(mark.text ?? '').split('\n').map(t => textMeasure ? textMeasure.measureText(t).width : Array.from(t).reduce((n,c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.6),0) * textPixels(mark.style)))
}
export function markBounds(mark: Mark): Rect {
  if (mark.tool === 'arrow') return arrowGeometry(mark).bounds
  const xs = mark.points.map(p => p.x), ys = mark.points.map(p => p.y)
  if (mark.tool === 'text') return { x: mark.points[0].x, y: mark.points[0].y, width: textWidth(mark) + 6, height: Math.max(1, (mark.text ?? '').split('\n').length) * textPixels(mark.style) * 1.35 + 6 }
  if (mark.tool === 'number') return { x: mark.points[0].x - mark.style.width, y: mark.points[0].y - mark.style.width, width: mark.style.width * 2, height: mark.style.width * 2 }
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}
export function hitMark(mark: Mark, point: Point, extra = 5): boolean {
  if (mark.tool === 'arrow') return arrowContains(mark, point, extra)
  const r = markBounds(mark), w = mark.style.width / 2 + extra
  if (!contains(r, point, w)) return false
  if (['text', 'number', 'mosaic', 'spotlight'].includes(mark.tool) || mark.style.fill) return true
  if (mark.tool === 'rect') return !contains({ x: r.x + w, y: r.y + w, width: r.width - w * 2, height: r.height - w * 2 }, point)
  if (mark.tool === 'ellipse') { const a = Math.max(1, r.width / 2), b = Math.max(1, r.height / 2); return Math.abs(Math.hypot((point.x - r.x - a) / a, (point.y - r.y - b) / b) - 1) * Math.min(a, b) <= w }
  return mark.points.some((p, index) => {
    const next = mark.points[index + 1] ?? p, dx = next.x - p.x, dy = next.y - p.y
    const t = clamp(((point.x - p.x) * dx + (point.y - p.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
    return distance(point, { x: p.x + t * dx, y: p.y + t * dy }) <= w
  })
}
export class History {
  private past: Mark[][] = []; private future: Mark[][] = []
  get canUndo() { return this.past.length > 0 } get canRedo() { return this.future.length > 0 }
  push(marks: Mark[]) { this.past.push(structuredClone(marks)); this.future = []; if (this.past.length > 100) this.past.shift() }
  undo(marks: Mark[]) { const value = this.past.pop(); if (!value) return marks; this.future.push(structuredClone(marks)); return value }
  redo(marks: Mark[]) { const value = this.future.pop(); if (!value) return marks; this.past.push(structuredClone(marks)); return value }
}
