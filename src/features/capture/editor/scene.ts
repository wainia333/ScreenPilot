import { clamp, clipRect, contains, defaultStyle, distance, History, hitMark, markBounds, rectBetween, resizeRect, selectionResizeHandle, selectionResizeCursor } from './model'
import type { CaptureSnapshot, Mark, Point, Rect, Style, Tool } from './model'
import { SmartSelectionAnimation } from './smart-selection'
type Drag = { kind: 'select' | 'move-selection' | 'resize-selection' | 'draw' | 'move-mark' | 'erase'; start: Point; before: Rect; handle: number; original: Mark | null; marksBefore: Mark[] }
export class CaptureScene {
  selection: Rect | null = null; hover: Rect | null = null; confirmed = false
  marks: Mark[] = []; selected: string | null = null; tool: Tool = 'cursor'; history = new History()
  drag: Drag | null = null; cursor: Point = { x: 0, y: 0 }; nextNumber = 1
  styles: Record<Tool, Style>; textEditing: string | null = null; lockRatio: number | null = null
  pendingOptions: Record<string, string | number | boolean> = {}
  onChange = () => { /* assigned to the frame scheduler in the constructor */ }; onCommit = () => { /* no host attached */ }
  private listeners = new Set<() => void>(); private revision = 0; private frame = 0
  private hoverAnimation = new SmartSelectionAnimation()
  get previewHover() { const value = this.hoverAnimation.at(performance.now()); if (!this.confirmed && !this.drag && this.hoverAnimation.active) this.onChange(); return value ?? this.hover }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); if (!this.listeners.size) { cancelAnimationFrame(this.frame); this.frame = 0 } } }
  getSnapshot = () => this.revision
  constructor(public snapshot: CaptureSnapshot) {
    this.onChange = () => { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.revision++; this.listeners.forEach(listener => listener()) }) }
    this.styles = Object.fromEntries(['cursor', 'pen', 'mosaic', 'spotlight', 'arrow', 'number', 'rect', 'ellipse', 'text', 'eraser'].map(tool => [tool, { ...defaultStyle(tool as Tool), ...snapshot.tools[tool as Tool] }])) as Record<Tool, Style>
    if (snapshot.selection) { this.selection = { ...snapshot.selection, x: snapshot.selection.x - snapshot.bounds.x, y: snapshot.selection.y - snapshot.bounds.y }; this.confirmed = true }
    if (snapshot.mode === 'pin') { this.selection = this.bounds; this.confirmed = true }
    if (snapshot.marks) this.marks = structuredClone(snapshot.marks).map(mark => ({ ...mark, style: { ...defaultStyle(mark.tool), ...mark.style } }))
  }
  get bounds(): Rect { return { x: 0, y: 0, width: this.snapshot.bounds.width, height: this.snapshot.bounds.height } }
  get active() { return this.marks.find(mark => mark.id === this.selected) }
  get style() { return this.styles[this.tool] }
  selectionHandleAt(p: Point) { return this.confirmed && this.tool === 'cursor' && this.selection && this.snapshot.mode !== 'pin' ? selectionResizeHandle(this.selection, p) : -1 }
  get pointerCursor() {
    if (this.drag?.kind === 'resize-selection') return selectionResizeCursor(this.drag.handle)
    const handle = this.selectionHandleAt(this.cursor)
    if (handle !== -1) return selectionResizeCursor(handle)
    return this.tool === 'text' ? 'text' : this.tool === 'cursor' && this.confirmed && this.selection && contains(this.selection, this.cursor) ? 'move' : 'crosshair'
  }
  setOption(key: string, value: string | number | boolean) { this.snapshot.options[key] = value; this.pendingOptions[key] = value; this.onCommit(); this.onChange() }
  setNextNumber(value: number) { this.nextNumber = value; this.onChange() }
  setRatio(value: number | null) { this.lockRatio = value; this.onChange() }
  setLayout(layout: NonNullable<CaptureSnapshot['tools']['layout']>) { this.snapshot.tools.layout = layout }
  setCommit(callback: () => void) { this.onCommit = callback }
  editText(id: string, text?: string) { const mark = this.marks.find(m => m.id === id); if (!mark) return; this.textEditing = id; if (text !== undefined) mark.text = text; this.onChange() }
  presetSelection(rect: Rect) { this.selection = rect; this.confirmed = true; this.onChange() }
  setHover(rect: Rect) { if (this.confirmed || this.drag) return; this.hover = clipRect(rect, this.bounds); this.hoverAnimation.to(this.hover, !!this.snapshot.options.smart_selection_animation, performance.now()); this.onChange() }
  setTool(tool: Tool, toggle = true) { this.finishText(); this.tool = toggle && this.tool === tool ? 'cursor' : tool; this.selected = null; this.onChange() }
  setStyle(patch: Partial<Style>) {
    Object.assign(this.styles[this.tool], patch)
    if (this.active) { this.history.push(this.marks); Object.assign(this.active.style, patch) }
    this.onCommit()
    this.onChange()
  }
  finishText() { if (!this.textEditing) return; this.marks = this.marks.filter(m => m.id !== this.textEditing || m.text?.trim()); this.textEditing = null; this.onCommit(); this.onChange() }
  undo() { this.finishText(); this.marks = this.history.undo(this.marks); this.selected = null; this.onCommit(); this.onChange() }
  redo() { this.marks = this.history.redo(this.marks); this.selected = null; this.onCommit(); this.onChange() }
  deleteSelected() { if (!this.selected) return; this.history.push(this.marks); this.marks = this.marks.filter(m => m.id !== this.selected); this.selected = null; this.onCommit(); this.onChange() }
  point(p: Point) { return { x: clamp(Math.round(p.x), 0, this.bounds.width), y: clamp(Math.round(p.y), 0, this.bounds.height) } }
  down(raw: Point, ctrl: boolean) {
    const p = this.point(raw); this.cursor = p; this.finishText()
    const marksBefore = structuredClone(this.marks)
    const drag = (kind: Drag['kind'], before = this.selection ?? this.bounds, handle = -1, original: Mark | null = null) => { this.drag = { kind, start: p, before: { ...before }, handle, original: original ? structuredClone(original) : null, marksBefore } }
    if (!this.confirmed) { drag('select'); this.selection = { ...p, width: 0, height: 0 }; this.onChange(); return }
    if (ctrl) {
      const mark = [...this.marks].reverse().find(m => hitMark(m, p))
      this.selected = mark?.id ?? null
      if (mark) drag('move-mark', markBounds(mark), -1, mark)
      this.onChange(); return
    }
    if (this.tool === 'cursor') {
      const handle = this.selectionHandleAt(p)
      if (handle !== -1 && this.selection) { this.selected = null; drag('resize-selection', this.selection, handle); this.onChange(); return }
      const mark = [...this.marks].reverse().find(m => hitMark(m, p))
      // Drawing tools always start a fresh stroke, including on existing marks.
      // Only the cursor selects on a plain click; Ctrl is required to move marks.
      if (mark) { this.selected = mark.id; this.onChange(); return }
    }
    this.selected = null
    if (this.selection && this.tool === 'cursor') {
      if (contains(this.selection, p)) { drag('move-selection'); this.onChange(); return }
      this.confirmed = false; drag('select'); this.selection = { ...p, width: 0, height: 0 }; this.onChange(); return
    }
    if (!this.selection || !contains(this.selection, p)) return
    if (this.tool === 'eraser') { drag('erase'); this.erase(p); this.onChange(); return }
    if (this.tool === 'cursor') return
    const mark: Mark = { id: crypto.randomUUID(), tool: this.tool, points: [p, p], style: { ...this.style }, rotation: 0 }
    if (this.tool === 'number') { mark.number = this.nextNumber++ }
    if (this.tool === 'text') { mark.text = ''; this.textEditing = mark.id }
    this.marks.push(mark); this.selected = mark.id; drag('draw', this.selection, -1, mark); this.onChange()
  }
  move(raw: Point, shift: boolean) {
    const p = this.point(raw); this.cursor = p
    const d = this.drag
    if (!d) {
      if (!this.confirmed && this.snapshot.options.smart_selection) {
        const global = { x: p.x + this.snapshot.bounds.x, y: p.y + this.snapshot.bounds.y }
        const window = this.snapshot.windows.find(w => contains(w, global))
        this.setHover(window ? { x: window.x - this.snapshot.bounds.x, y: window.y - this.snapshot.bounds.y, width: window.width, height: window.height } : this.bounds)
      }
      this.onChange(); return
    }
    const dx = p.x - d.start.x, dy = p.y - d.start.y
    if (d.kind === 'select') {
      if (Math.abs(dx) + Math.abs(dy) <= 10) { this.onChange(); return }
      this.selection = rectBetween(d.start, p, shift)
      if (this.lockRatio) { const r = this.selection; r.height = r.width / this.lockRatio }
      this.selection = clipRect(this.selection, this.bounds)
    } else if (d.kind === 'resize-selection') this.selection = clipRect(resizeRect(d.before, d.handle, p), this.bounds)
    else if (d.kind === 'move-selection') this.selection = { ...d.before, x: clamp(d.before.x + dx, 0, this.bounds.width - d.before.width), y: clamp(d.before.y + dy, 0, this.bounds.height - d.before.height) }
    else if (d.kind === 'erase') this.erase(p)
    else if (d.kind === 'draw' && this.active) {
      const mark = this.active
      if (['pen', 'mosaic'].includes(mark.tool) && mark.style.mode !== 'rect') {
        if (shift && mark.tool !== 'mosaic') mark.points = [d.start, Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: d.start.y } : { x: d.start.x, y: p.y }]
        else { const last = mark.points.at(-1) ?? mark.points[0]; if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 1.5) mark.points.push(p) }
      } else if (!['text', 'number'].includes(mark.tool)) {
        const square = shift && ['rect', 'ellipse', 'spotlight'].includes(mark.tool)
        const r = rectBetween(d.start, p, square)
        mark.points = square ? [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height }] : [d.start, p]
      }
    } else if (d.kind === 'move-mark' && d.original && this.active) this.active.points = mapPoints(d.original.points, pt => ({ x: pt.x + dx, y: pt.y + dy }))
    this.onChange()
  }
  up() {
    const d = this.drag; this.drag = null
    if (!d) return
    if (d.kind === 'select') {
      if (!this.selection || Math.abs(this.cursor.x - d.start.x) + Math.abs(this.cursor.y - d.start.y) <= 10) this.selection = this.hover ? { ...this.hover } : null
      this.confirmed = !!this.selection && this.selection.width > 1 && this.selection.height > 1
    }
    if (d.kind === 'draw' && this.active?.tool === 'arrow' && distance(this.active.points[0], this.active.points[1]) < 10) { this.marks = d.marksBefore; this.selected = null }
    if (['draw', 'erase', 'move-mark'].includes(d.kind) && JSON.stringify(d.marksBefore) !== JSON.stringify(this.marks)) { this.history.push(d.marksBefore); this.onCommit() }
    this.onChange()
  }
  private erase(p: Point) { this.marks = this.marks.filter(m => !hitMark(m, p, this.style.width / 2)) }
}
function mapPoints(points: Mark['points'], transform: (point: Point) => Point): Mark['points'] { return [transform(points[0]), transform(points[1]), ...points.slice(2).map(transform)] }
