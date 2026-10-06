import { describe, expect, it } from 'vitest'
import { CaptureScene } from './scene'
import { clipRect, defaultStyle, handles, hitMark, markBounds, normalizeLayout, rectBetween, resizeRect, screenFor, toolbarPosition, type CaptureSnapshot, type Mark, type Tool } from './model'
const snapshot = (): CaptureSnapshot => ({ id: 'test', mode: 'image', bounds: { x: -1280, y: -200, width: 2560, height: 1440 }, screens: [{ x: -1280, y: -200, width: 1280, height: 1440 }, { x: 0, y: -200, width: 1280, height: 1440 }], image: '', options: { smart_selection: true }, tools: {}, windows: [{ id: 2, owner: 'fixture', title: 'test', x: -1180, y: -100, width: 800, height: 500 }], selection: null })
function selected() { const scene = new CaptureScene(snapshot()); scene.presetSelection({ x: 100, y: 100, width: 900, height: 600 }); return scene }
function stroke(scene: CaptureScene, from = { x: 200, y: 200 }, to = { x: 500, y: 350 }) { scene.down(from, false); scene.move(to, false); scene.up() }
function requiredMark(scene: CaptureScene): Mark { const mark = scene.marks[0]; if (!mark) throw new Error('Expected a committed annotation'); return mark }
describe('upstream capture interaction contract', () => {
  it('keeps absolute monitor coordinates separate from document pixels', () => {
    const s = snapshot(); s.selection = { x: -1000, y: -50, width: 200, height: 160 }
    expect(new CaptureScene(s).selection).toEqual({ x: 280, y: 150, width: 200, height: 160 })
    expect(screenFor({ x: -1000, y: 20, width: 100, height: 100 }, s.screens)?.x).toBe(-1280)
  })
  it('retains the original 10px Manhattan threshold and single-click smart selection', () => {
    const scene = new CaptureScene(snapshot()); scene.move({ x: 200, y: 200 }, false); scene.down({ x: 200, y: 200 }, false); scene.move({ x: 204, y: 205 }, false); scene.up()
    expect(scene.selection).toEqual({ x: 100, y: 100, width: 800, height: 500 }); expect(scene.confirmed).toBe(true)
  })
  it('normalizes reverse dragging and constrains selection to the desktop', () => {
    const scene = new CaptureScene(snapshot()); stroke(scene, { x: 700, y: 500 }, { x: 200, y: 160 })
    expect(scene.selection).toEqual({ x: 200, y: 160, width: 500, height: 340 })
    scene.setTool('cursor'); stroke(scene, { x: 350, y: 320 }, { x: 2550, y: 1420 }); expect(scene.selection?.x).toBe(2060); expect(scene.selection?.y).toBe(1100)
  })
  it('keeps pen spacing and gives one undo entry to one stroke', () => {
    const scene = selected(); scene.setTool('pen'); scene.down({ x: 200, y: 200 }, false)
    for (let i = 1; i <= 20; i++) scene.move({ x: 200 + i, y: 210 }, false)
    scene.up(); expect(scene.marks).toHaveLength(1); expect(scene.marks[0]?.style.width).toBe(12)
    scene.undo(); expect(scene.marks).toHaveLength(0); scene.redo(); expect(scene.marks).toHaveLength(1)
  })
  it('clicking an active tool toggles back to cursor; keys may activate without toggling', () => { const scene = selected(); scene.setTool('rect'); scene.setTool('rect'); expect(scene.tool).toBe('cursor'); scene.setTool('rect', false); scene.setTool('rect', false); expect(scene.tool).toBe('rect') })
  it('discards arrows shorter than ten physical pixels', () => { const scene = selected(); scene.setTool('arrow'); stroke(scene, { x: 250, y: 250 }, { x: 254, y: 253 }); expect(scene.marks).toHaveLength(0); expect(scene.history.canUndo).toBe(false) })
  it('preserves an existing curved arrow during Ctrl movement, deletion and undo', () => {
    const scene = selected(); scene.setTool('arrow'); stroke(scene); requiredMark(scene).points.push({ x: 340, y: 190 })
    const initial = structuredClone(scene.marks)
    scene.down({ x: 200, y: 200 }, true); scene.move({ x: 225, y: 215 }, false); scene.up()
    expect(requiredMark(scene).points).toEqual([{ x: 225, y: 215 }, { x: 525, y: 365 }, { x: 365, y: 205 }])
    scene.undo(); expect(scene.marks).toEqual(initial); scene.redo()
    scene.down({ x: 225, y: 215 }, true); scene.up(); scene.deleteSelected(); expect(scene.marks).toHaveLength(0)
    scene.undo(); expect(scene.marks).toHaveLength(1); expect(requiredMark(scene).points[2]).toEqual({ x: 365, y: 205 })
  })
  it('handles square shapes, tool-specific colors and opacity without changing defaults for other tools', () => {
    const scene = selected(); scene.setTool('rect'); scene.setStyle({ color: '#123456', width: 4, opacity: 0.5 }); scene.down({ x: 200, y: 200 }, false); scene.move({ x: 280, y: 320 }, true); scene.up()
    expect(markBounds(requiredMark(scene))).toEqual({ x: 200, y: 200, width: 120, height: 120 }); scene.setTool('pen'); expect(scene.style.color).toBe('#FF0000'); scene.setTool('rect'); expect(scene.style.width).toBe(4)
  })
  it('supports text editing and erasing with reversible history', () => {
    const scene = selected(); scene.setTool('text'); stroke(scene); const id = scene.textEditing; expect(id).not.toBeNull(); if (!id) return
    scene.editText(id, '中文\nText'); scene.finishText(); expect(markBounds(requiredMark(scene)).height).toBeCloseTo(2 * (14 * 96 / 72) * 1.35 + 6)
    scene.setTool('eraser'); stroke(scene, { x: 200, y: 200 }, { x: 220, y: 210 }); expect(scene.marks).toHaveLength(0); scene.undo(); expect(scene.marks[0]?.text).toBe('中文\nText')
  })
  it('numbers each new marker and maintains shape hit testing', () => { const scene = selected(); scene.setTool('number'); stroke(scene); scene.setTool('number', false); stroke(scene, { x: 400, y: 400 }, { x: 400, y: 400 }); expect(scene.marks.map(m => m.number)).toEqual([1, 2]); expect(hitMark(requiredMark(scene), { x: 200, y: 200 })).toBe(true) })
})
describe('toolbar and geometry parity', () => {
  it('uses matching resize cursors and drag hit areas on all selection edges, including away from midpoint handles', () => {
    const cases = [
      { p: { x: 100, y: 100 }, handle: 0, cursor: 'nwse-resize' },
      { p: { x: 350, y: 100 }, handle: 1, cursor: 'ns-resize' },
      { p: { x: 1000, y: 100 }, handle: 2, cursor: 'nesw-resize' },
      { p: { x: 1000, y: 280 }, handle: 3, cursor: 'ew-resize' },
      { p: { x: 1000, y: 700 }, handle: 4, cursor: 'nwse-resize' },
      { p: { x: 350, y: 700 }, handle: 5, cursor: 'ns-resize' },
      { p: { x: 100, y: 700 }, handle: 6, cursor: 'nesw-resize' },
      { p: { x: 100, y: 280 }, handle: 7, cursor: 'ew-resize' },
    ]
    for (const { p, handle, cursor } of cases) {
      const scene = selected(); scene.move(p, false)
      expect(scene.pointerCursor).toBe(cursor)
      scene.down(p, false); expect(scene.drag).toMatchObject({ kind: 'resize-selection', handle })
      const target = { x: p.x + 12, y: p.y + 10 }
      scene.move(target, false)
      expect(scene.pointerCursor).toBe(cursor)
      expect(scene.selection).toEqual(resizeRect({ x: 100, y: 100, width: 900, height: 600 }, handle, target))
      scene.up()
    }
    const scene = selected(); scene.move({ x: 200, y: 200 }, false); expect(scene.pointerCursor).toBe('move')
    scene.move({ x: 40, y: 40 }, false); expect(scene.pointerCursor).toBe('crosshair')
    scene.setTool('pen', false); scene.move({ x: 350, y: 100 }, false); expect(scene.pointerCursor).toBe('crosshair')
  })
  it('combines legacy shape entries at their first position without losing visible tools', () => {
    const layout = normalizeLayout([{ key: 'pen', mode: 'show' }, { key: 'ellipse', mode: 'hide' }, { key: 'rect', mode: 'show' }])
    expect(layout.slice(0, 2)).toEqual([{ key: 'pen', mode: 'show' }, { key: 'shape', mode: 'show' }])
    expect(layout.some(entry => entry.key === 'rect' || entry.key === 'ellipse')).toBe(false)
    expect(layout.filter(entry => entry.key === 'shape')).toHaveLength(1)
    expect(normalizeLayout([{ key: 'rect', mode: 'hide' }, { key: 'ellipse', mode: 'more' }]).find(entry => entry.key === 'shape')?.mode).toBe('more')
    expect(normalizeLayout([{ key: 'rect', mode: 'show' }, { key: 'shape', mode: 'hide' }]).find(entry => entry.key === 'shape')?.mode).toBe('hide')
  })
  it('aligns the confirm edge and flips above with space reserved for panels', () => {
    expect(toolbarPosition({ x: 300, y: 100, width: 650, height: 300 }, { x: 0, y: 0, width: 1280, height: 800 }, 740, 1)).toEqual({ x: 226, y: 410, below: true })
    expect(toolbarPosition({ x: 300, y: 600, width: 650, height: 180 }, { x: 0, y: 0, width: 1280, height: 800 }, 740, 1)).toEqual({ x: 226, y: 550, below: false })
  })
  it('clips a toolbar to a negative-origin monitor', () => { const at = toolbarPosition({ x: -1270, y: 10, width: 100, height: 200 }, { x: -1280, y: 0, width: 1280, height: 720 }, 740, 1); expect(at.x).toBe(-1280) })
  it('restores new toolbar actions, removes duplicates, keeps the save/copy pair visible at the right', () => { const layout = normalizeLayout([{ key: 'confirm', mode: 'hide' }, { key: 'pen', mode: 'more' }, { key: 'pen', mode: 'hide' }, { key: 'save', mode: 'more' }]); expect(layout.filter(e => e.key === 'pen')).toHaveLength(1); expect(layout.slice(-2)).toEqual([{ key: 'save', mode: 'show' }, { key: 'confirm', mode: 'show' }]); expect(layout.find(e => e.key === 'scan_code')?.mode).toBe('more') })
  it('does not invent different drawing defaults', () => { expect(defaultStyle('pen').width).toBe(12); expect(defaultStyle('mosaic').block).toBe(10); expect(defaultStyle('text').fontSize).toBe(14); expect(defaultStyle('arrow').width).toBe(9) })
  it('discards retired toolbar entries without dropping other custom tool ordering', () => {
    const legacy = [{ key: 'save', mode: 'show' }, { key: 'highlighter', mode: 'show' }, { key: 'arrow', mode: 'more' }, { key: 'pen', mode: 'show' }, { key: 'confirm', mode: 'show' }] as NonNullable<CaptureSnapshot['tools']['layout']>
    const layout = normalizeLayout(legacy)
    expect(layout.slice(0, 2)).toEqual([{ key: 'arrow', mode: 'more' }, { key: 'pen', mode: 'show' }])
    expect(layout.map(entry => entry.key)).not.toContain('highlighter')
    expect(layout.slice(-2).map(entry => entry.key)).toEqual(['save', 'confirm'])
  })
  it('shows spotlight immediately after GIF and migrates its former overflow position', () => {
    const layout = normalizeLayout([{ key: 'gif', mode: 'show' }, { key: 'pen', mode: 'show' }, { key: 'mosaic', mode: 'show' }, { key: 'spotlight', mode: 'more' }])
    expect(layout.slice(0, 4)).toEqual([{ key: 'gif', mode: 'show' }, { key: 'spotlight', mode: 'show' }, { key: 'pen', mode: 'show' }, { key: 'mosaic', mode: 'show' }])
    expect(normalizeLayout(layout)).toEqual(layout)
    const customized = layout.map(entry => entry.key === 'spotlight' ? { ...entry, mode: 'hide' as const } : entry)
    expect(normalizeLayout(customized).find(entry => entry.key === 'spotlight')?.mode).toBe('hide')
  })
  it('normalizes reverse rectangles and resizes all eight handles', () => { const r = { x: 100, y: 100, width: 100, height: 100 }; expect(rectBetween({ x: 200, y: 200 }, { x: 100, y: 100 })).toEqual(r); expect(handles(r)).toHaveLength(8); for (let i = 0; i < 8; i++) { const next = resizeRect(r, i, { x: 50, y: 50 }); expect(next.width).toBeGreaterThan(0); expect(next.height).toBeGreaterThan(0) } expect(clipRect({ x: -10, y: -10, width: 30, height: 30 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 20, height: 20 }) })
})

describe('annotation movement gestures', () => {
  const fixtures: { tool: Exclude<Tool, 'cursor' | 'eraser'>; body: { x: number; y: number } }[] = [
    { tool: 'pen', body: { x: 300, y: 250 } },
    { tool: 'rect', body: { x: 275, y: 200 } }, { tool: 'ellipse', body: { x: 456, y: 328 } },
    { tool: 'arrow', body: { x: 290, y: 245 } }, { tool: 'mosaic', body: { x: 300, y: 250 } },
    { tool: 'spotlight', body: { x: 300, y: 250 } }, { tool: 'number', body: { x: 200, y: 200 } },
    { tool: 'text', body: { x: 225, y: 215 } },
  ]
  it.each(fixtures)('cursor left-drag selects $tool but leaves its pixels and the capture region in place', ({ tool, body }) => {
    const scene = selected(); scene.setTool(tool); stroke(scene)
    if (tool === 'text') { scene.editText(requiredMark(scene).id, 'Annotation'); scene.finishText() }
    const before = structuredClone(scene.marks), selection = { ...scene.selection }
    scene.setTool('cursor', false); expect(hitMark(requiredMark(scene), body)).toBe(true)
    scene.down(body, false); expect(scene.drag).toBeNull()
    scene.move({ x: body.x + 45, y: body.y + 30 }, false); scene.up()
    expect(scene.selected).toBe(before[0]?.id); expect(scene.marks).toEqual(before); expect(scene.selection).toEqual(selection)
  })
  it.each(fixtures)('$tool continues drawing from an existing mark with either cross-tool preference', ({ tool, body }) => {
    for (const crossTool of [false, true]) {
      const scene = selected(); scene.snapshot.options.cross_tool_selection = crossTool; scene.setTool(tool); stroke(scene)
      if (tool === 'text') { scene.editText(requiredMark(scene).id, 'Annotation'); scene.finishText() }
      const before = structuredClone(scene.marks), selection = { ...scene.selection }
      expect(hitMark(requiredMark(scene), body)).toBe(true)
      scene.down(body, false); expect(scene.drag?.kind).toBe('draw')
      scene.move({ x: body.x + 45, y: body.y + 30 }, false); scene.up()
      expect(scene.marks).toHaveLength(2); expect(scene.marks[0]).toEqual(before[0]); expect(scene.marks[1]?.points[0]).toEqual(body)
      expect(scene.selection).toEqual(selection)
      if (tool === 'text') { const mark = scene.active; if (!mark) throw new Error('Expected the new text annotation'); scene.editText(mark.id, 'Continued'); scene.finishText() }
      scene.undo(); expect(scene.marks).toEqual(before); scene.redo(); expect(scene.marks).toHaveLength(2)
    }
  })
  it.each(fixtures)('Ctrl alone moves $tool, preserving points, styles and the region through undo', ({ tool, body }) => {
    const scene = selected(); scene.setTool(tool); stroke(scene)
    if (tool === 'text') { scene.editText(requiredMark(scene).id, 'Annotation'); scene.finishText() }
    const before = structuredClone(scene.marks), selection = { ...scene.selection }
    scene.setTool('pen', false); scene.down(body, true); expect(scene.drag?.kind).toBe('move-mark')
    scene.move({ x: body.x + 40, y: body.y + 30 }, false); scene.up()
    expect(scene.marks).toHaveLength(1); expect(requiredMark(scene).points).toEqual(before[0]?.points.map(point => ({ x: point.x + 40, y: point.y + 30 })))
    expect(requiredMark(scene).style).toEqual(before[0]?.style); expect(scene.selection).toEqual(selection)
    scene.undo(); expect(scene.marks).toEqual(before); scene.redo(); expect(requiredMark(scene).points[0]).toEqual({ x: 240, y: 230 })
  })
  it('former frame edges, resize corners and arrow control points no longer intercept drawing', () => {
    for (const { tool, start } of [{ tool: 'rect' as const, start: { x: 250, y: 197 } }, { tool: 'rect' as const, start: { x: 200, y: 200 } }, { tool: 'arrow' as const, start: { x: 350, y: 275 } }]) {
      const scene = selected(); scene.setTool(tool); stroke(scene); const before = structuredClone(scene.marks)
      scene.down(start, false); expect(scene.drag?.kind).toBe('draw'); scene.move({ x: start.x + 40, y: start.y + 30 }, false); scene.up()
      expect(scene.marks).toHaveLength(2); expect(scene.marks[0]).toEqual(before[0])
    }
  })
  it('Ctrl on empty pixels neither draws nor moves the capture region', () => {
    const scene = selected(); scene.setTool('pen'); stroke(scene); const before = structuredClone(scene.marks), selection = { ...scene.selection }
    scene.down({ x: 700, y: 500 }, true); expect(scene.drag).toBeNull(); scene.move({ x: 740, y: 530 }, false); scene.up()
    expect(scene.marks).toEqual(before); expect(scene.selection).toEqual(selection)
  })
  it('Ctrl moves the body across tools even when cross-tool selection is disabled, including endpoints', () => {
    const scene = selected(); scene.snapshot.options.cross_tool_selection = false; scene.setTool('rect'); stroke(scene)
    scene.setTool('pen', false); scene.down({ x: 200, y: 200 }, true)
    expect(scene.drag?.kind).toBe('move-mark'); scene.move({ x: 225, y: 215 }, false); scene.up()
    expect(scene.marks).toHaveLength(1); expect(markBounds(requiredMark(scene))).toEqual({ x: 225, y: 215, width: 300, height: 150 })
    scene.undo(); expect(markBounds(requiredMark(scene))).toEqual({ x: 200, y: 200, width: 300, height: 150 })
  })
})
