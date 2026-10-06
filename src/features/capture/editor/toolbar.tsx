import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { clamp, defaultLayout, normalizeLayout, screenFor, toolbarPosition } from './model'
import type { LayoutEntry, Point, Style, Tool, ToolAction } from './model'
import type { CaptureScene } from './scene'
import { Stepper, PreviewChoice, ModeButtons } from './style-controls'
import { MosaicStrength } from './mosaic-controls'
import { TextEffects } from './text-effects'
import { Check, ChevronDown, Circle, Copy, Download, Eraser, GripVertical, Pen, Redo2, ScanQrCode, Square, Type, Undo2, X, type LucideIcon } from 'lucide-react'
const images = import.meta.glob<string>('../assets/*.svg', { eager: true, query: '?url', import: 'default' })
const iconNames: Record<string, string> = { long_screenshot: '长截图', save: '下载', scan_code: '扫码', gif: 'gif', pen: '画笔', mosaic: '马赛克', spotlight: '聚光灯', arrow: '箭头', number: '序号', rect: '方框', ellipse: '圆框', text: '文字', eraser: '橡皮', undo: '撤回', redo: '复原', cancel: '结束截图', pin: '钉图', confirm: '确定', copy: 'copy', start: '开始录制', stop: '结束录制', pause: '暂停录制', restart: '重新录制', mouse: '鼠标', previous: '后退', next: '前进', rotate: '旋转', toolbar: '工具栏', rounded: '圆角', border: '阴影描边', ratio: '保持纵横比' }
const toolLabels: Record<string, string> = { long_screenshot: '长截图（滚动）', save: '保存到文件', scan_code: '扫描二维码 / 条形码', gif: 'GIF / 视频录制', pen: '画笔（Shift 直线）', mosaic: '马赛克（滚轮调整大小）', spotlight: '聚光灯', arrow: '箭头', number: '序号（Shift + 滚轮调整数字）', shape: '形状（矩形 / 椭圆）', rect: '矩形（Shift 正方形）', ellipse: '椭圆（Shift 正圆）', text: '文字', eraser: '橡皮擦', undo: '撤销 Ctrl+Z', redo: '重做 Ctrl+Y', cancel: '结束截图 Esc', pin: '钉图', confirm: '完成并复制 Enter', copy: '复制图片' }
function PinIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-pin-icon="diagonal"><g transform="rotate(45 12 12)"><path d="M9 3h6M9 3v6l-3 4v2h12v-2l-3-4V3M12 15v6" /></g></svg>
}
function ShapeIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /><circle cx="16" cy="16" r="5" /></svg>
}
function MosaicIcon() {
  const shades = [0.35, 0.7, 1, 0.45, 0.8, 1, 0.45, 0.7, 1, 0.5, 0.8, 0.3, 0.5, 0.85, 0.35, 1]
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-capture-icon="mosaic"><rect x="2.5" y="2.5" width="19" height="19" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />{shades.map((opacity, index) => <rect key={index} x={3.5 + index % 4 * 4.4} y={3.5 + Math.floor(index / 4) * 4.4} width="3.8" height="3.8" opacity={opacity} />)}</svg>
}
function TaperedArrowIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-capture-icon="tapered-arrow"><path d="M3 21 12 9.5 8 8 21 3 16 16 14.5 12Z" /></svg>
}
export function CaptureIcon({ name }: { name: string }) { return name === 'pin' ? <PinIcon /> : name === 'shape' ? <ShapeIcon /> : name === 'mosaic' ? <MosaicIcon /> : name === 'arrow' ? <TaperedArrowIcon /> : name === 'save' ? <Download size={22} strokeWidth={1.8} aria-hidden="true" /> : name === 'confirm' || name === 'copy' ? <Copy size={22} strokeWidth={1.8} aria-hidden="true" /> : name === 'pen' ? <Pen size={22} strokeWidth={1.8} aria-hidden="true" /> : <img draggable={false} alt="" src={images[`../assets/${name === 'number' ? 'number-badge' : iconNames[name] ?? name}.svg`]} /> }
const toolbarIcons: Record<string, LucideIcon> = { save: Download, scan_code: ScanQrCode, pen: Pen, rect: Square, ellipse: Circle, text: Type, eraser: Eraser, undo: Undo2, redo: Redo2, cancel: X, confirm: Copy, copy: Copy }
const drawingTools = new Set(['pen', 'mosaic', 'spotlight', 'arrow', 'number', 'rect', 'ellipse', 'text', 'eraser'])
const wide = new Set(['long_screenshot', 'save', 'scan_code', 'gif', 'cancel', 'pin', 'confirm', 'copy'])
export function ToolButton({ name, active, disabled, onClick }: { name: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  const Icon = toolbarIcons[name]
  return <button type="button" className={`jt-tool ${wide.has(name) ? 'jt-tool-wide' : ''}`} data-tool={name} title={toolLabels[name] ?? name} aria-label={toolLabels[name] ?? name} aria-pressed={active} disabled={disabled} onClick={onClick}>{name === 'long_screenshot' ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9M7 8h4M7 12h4M7 16h4M19 3v18m-3-15 3-3 3 3m-6 12 3 3 3-3" /></svg> : Icon ? <Icon size={22} strokeWidth={1.8} aria-hidden="true" /> : <CaptureIcon name={name} />}</button>
}
export function ShapeButton({ scene, disabled = false, below = true, onSelect }: { scene: CaptureScene; disabled?: boolean; below?: boolean; onSelect?: () => void }) {
  const [open, setOpen] = useState(false), [right, setRight] = useState(false), [placeBelow, setPlaceBelow] = useState(below)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const shape = scene.tool === 'rect' || scene.tool === 'ellipse' ? scene.tool : null
  const choose = (tool: 'rect' | 'ellipse') => { scene.setTool(tool, false); setOpen(false); trigger.current?.focus(); onSelect?.() }
  const show = () => {
    const r = root.current?.getBoundingClientRect()
    if (r) {
      const scale = r.width / 40, height = 94 * scale, spaceBelow = window.innerHeight - r.bottom, spaceAbove = r.top
      setRight(r.left + 176 * scale > window.innerWidth - 8)
      setPlaceBelow(below ? spaceBelow >= height || spaceBelow >= spaceAbove : spaceAbove < height && spaceBelow > spaceAbove)
    }
    setOpen(true)
  }
  useEffect(() => {
    if (!open || disabled) return
    const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked=true]') ?? menu.current?.querySelector<HTMLButtonElement>('button')
    selected?.focus()
    const close = (event: globalThis.PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close)
  }, [open, disabled])
  return <div ref={root} className="jt-shape-choice" onKeyDown={e => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation()
      if (!open) { show(); return }
      const items = [...menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []], index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
    }
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
  }}>
    <button ref={trigger} type="button" className="jt-tool" data-tool="shape" aria-label={toolLabels.shape} title={toolLabels.shape} aria-haspopup="menu" aria-expanded={open && !disabled} aria-pressed={!!shape} disabled={disabled} onClick={() => { if (open) setOpen(false); else show() }}><ShapeIcon /><ChevronDown className="jt-shape-caret" size={8} strokeWidth={2} aria-hidden="true" /></button>
    {open && !disabled && <div ref={menu} role="menu" aria-label="选择形状" className={`jt-shape-menu jt-panel ${placeBelow ? 'below' : 'above'} ${right ? 'align-right' : ''}`} data-capture-interactive>
      {(['rect', 'ellipse'] as const).map(tool => { const Icon = toolbarIcons[tool]; return <button type="button" role="menuitemradio" aria-label={toolLabels[tool]} aria-checked={shape === tool} key={tool} onClick={() => choose(tool)}>{Icon && <Icon size={20} strokeWidth={1.8} aria-hidden="true" />}<span>{tool === 'rect' ? '矩形' : '椭圆'}</span><kbd>{scene.snapshot.mode === 'pin' ? '' : tool === 'rect' ? 'R' : 'O'}</kbd><Check className="jt-shape-check" size={14} strokeWidth={2} aria-hidden="true" style={{ visibility: shape === tool ? 'visible' : 'hidden' }} /></button> })}
    </div>}
  </div>
}
const colors = ['#FF0000', '#FFFF00', '#00FF00', '#0000FF', '#000000', '#FFFFFF']
function Choice({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <select title={label} aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{options.map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select>
}
export function ToolPanel({ scene }: { scene: CaptureScene }) {
  const tool = scene.tool, s = scene.active?.style ?? scene.style
  const set = (patch: Partial<Style>) => scene.setStyle(patch)
  return <div className={`jt-panel jt-tool-panel ${tool === 'text' ? 'jt-text-panel' : ''}`} data-capture-interactive>
    {tool === 'mosaic' ? <>
      <ModeButtons label="绘制方式" value={s.mode} options={[{ value: 'freehand', title: '自由涂抹', icon: <CaptureIcon name="pen" /> }, { value: 'rect', title: '矩形马赛克', icon: <CaptureIcon name="rect" /> }]} onChange={mode => set({ mode: mode as Style['mode'] })} />
      <Stepper label="马赛克大小" value={s.width} max={200} onChange={width => set({ width })} />
      <span className="jt-separator" /><MosaicStrength value={s.block} smooth={s.mosaic === 'blur'} onChange={block => set({ block })} />
      <Choice label="马赛克样式" value={s.mosaic} options={[["pixelate", "马赛克"], ["blur", "模糊"]]} onChange={v => set({ mosaic: v as Style['mosaic'] })} />
    </> : tool === 'eraser' ? <><span>大小</span><Stepper label="橡皮擦大小" value={s.width} max={200} onChange={width => set({ width })} /></> : <>
      {tool === 'arrow' && <PreviewChoice kind="arrow" label="箭头样式" value={s.arrow} options={[["single", "实心箭头"], ["double", "双向箭头"], ["hollow", "空心箭头"], ["line", "线条箭头"], ["line_double", "双向线条"], ["triangle", "三角箭头"], ["triangle_double", "双向三角"], ["bar", "工字标注"], ["bar_arrow", "工字双箭头"]]} onChange={arrow => set({ arrow })} />}
      {['pen', 'rect', 'ellipse'].includes(tool) && <PreviewChoice kind="line" label="线条样式" value={s.line} options={[["solid", "实线"], ["dashed", "虚线"], ["dashed_dense", "点线"]]} onChange={line => set({ line: line as Style['line'] })} />}
      {tool === 'number' && <><PreviewChoice kind="number" label="序号样式" value={s.number} options={[["solid", "实心"], ["hollow_bg", "白底描边"], ["hollow_all", "透明描边"], ["no_circle", "仅数字"]]} onChange={number => set({ number: number as Style['number'] })} /><Stepper label="下一个序号" value={scene.nextNumber} max={999} onChange={n => { scene.setNextNumber(n) }} /></>}
      {tool === 'text' && <>
        <Choice label="字体" value={s.font} options={['Microsoft YaHei UI', 'SimSun', 'Segoe UI', 'Arial', 'Yu Gothic UI', 'Meiryo', 'Microsoft JhengHei UI', 'PMingLiU'].map(v => [v, v])} onChange={font => set({ font })} />
        <Stepper label="字号" value={s.fontSize} min={6} max={200} onChange={fontSize => set({ fontSize })} />
        <button type="button" aria-label="粗体" aria-pressed={s.bold} onClick={() => set({ bold: !s.bold })}><b>B</b></button>
        <button type="button" aria-label="斜体" aria-pressed={s.italic} onClick={() => set({ italic: !s.italic })}><i>I</i></button>
        <button type="button" aria-label="下划线" aria-pressed={s.underline} onClick={() => set({ underline: !s.underline })}><u>U</u></button>
        <TextEffects style={s} onChange={set} />
      </>}
      {tool !== 'text' && tool !== 'spotlight' && <Stepper label="线宽" value={s.width} min={tool === 'number' ? 8 : 1} onChange={width => set({ width })} />}
      {tool !== 'text' && <Stepper label="不透明度" suffix="%" value={Math.round(s.opacity * 100)} min={0} max={100} onChange={v => set({ opacity: v / 100 })} />}
      {tool !== 'spotlight' && <>
        <span className="jt-separator" />
        <input type="color" title="自定义颜色" aria-label="自定义颜色" value={s.color} onChange={e => set({ color: e.target.value })} />
        <div className="jt-colors">{colors.map(color => <button key={color} type="button" title={color} aria-label={`颜色 ${color}`} aria-pressed={s.color.toUpperCase() === color} style={{ background: color }} onClick={() => set({ color })} />)}</div>
      </>}
      {tool === 'rect' && <><span>圆角</span><Stepper label="矩形圆角" value={s.radius} min={0} max={100} onChange={radius => set({ radius })} /></>}
      {['rect', 'ellipse'].includes(tool) && <label><input type="checkbox" checked={s.fill} onChange={e => set({ fill: e.target.checked })} />填充</label>}
    </>}
  </div>
}
export function CaptureToolbar({ scene, scale: requestedScale, action, persist, busy = false, fixedLayout, fixedPosition, fixedBelow, screenBounds }: { scene: CaptureScene; scale: number; action: (action: ToolAction) => void; persist: () => void; busy?: boolean; fixedLayout?: LayoutEntry[]; fixedPosition?: Point; fixedBelow?: boolean; screenBounds?: CaptureScene['bounds'] }) {
  const [more, setMore] = useState(false), [editing, setEditing] = useState(false), [manual, setManual] = useState<Point | null>(null)
  const [layout, setLayout] = useState(() => fixedLayout ?? normalizeLayout(scene.snapshot.tools.layout))
  const movable = layout.filter(entry => !['spotlight', 'save', 'confirm'].includes(entry.key))
  const selection = scene.selection ?? scene.bounds
  const shown = layout.filter(entry => entry.mode === 'show'), hidden = layout.filter(entry => entry.mode === 'more')
  const width = (fixedLayout ? 15 : 28) + shown.reduce((sum, entry) => sum + (wide.has(entry.key) ? 45 : 40), 0)
  const screens = scene.snapshot.screens.map(r => ({ ...r, x: r.x - scene.snapshot.bounds.x, y: r.y - scene.snapshot.bounds.y }))
  const screen = screenBounds ?? screenFor(selection, screens) ?? scene.bounds
  const scale = Math.min(requestedScale, Math.max(0.25, (screen.width - 16) / width))
  const position = toolbarPosition(selection, screen, width * scale, scale, scene.tool === 'text' ? 94 : 48)
  const at = manual ?? fixedPosition ?? position
  const panelBelow = fixedBelow ?? (position.below || at.y - screen.y < (scene.tool === 'text' ? 99 : 53) * scale)
  const menuBelow = screen.y + screen.height - at.y > 165 * scale || at.y - screen.y < 125 * scale
  const select = (key: ToolAction) => { setMore(false); if (drawingTools.has(key)) scene.setTool(key as Tool); else action(key) }
  const pointer = (e: { clientX: number; clientY: number }) => ({ x: e.clientX * (fixedPosition ? window.devicePixelRatio : scene.bounds.width / window.innerWidth), y: e.clientY * (fixedPosition ? window.devicePixelRatio : scene.bounds.height / window.innerHeight) })
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    const element = e.currentTarget, start = pointer(e), initial = { x: at.x, y: at.y }; element.setPointerCapture(e.pointerId)
    const move = (event: globalThis.PointerEvent) => { const point = pointer(event); setManual({ x: clamp(initial.x + point.x - start.x, screen.x, screen.x + screen.width - width * scale), y: clamp(initial.y + point.y - start.y, screen.y, screen.y + screen.height - 40 * scale) }) }
    const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end) }
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end)
  }
  const updateLayout = (entries: LayoutEntry[]) => { const normalized = normalizeLayout(entries); setLayout(normalized); scene.setLayout(normalized); persist() }
  const moveEntry = (key: ToolAction, direction: number) => {
    const next = [...movable], index = next.findIndex(entry => entry.key === key), entry = next[index], other = next[index + direction]
    if (!entry || !other) return
    next[index + direction] = entry; next[index] = other
    const spotlight = layout.find(entry => entry.key === 'spotlight')
    updateLayout(next.flatMap(entry => entry.key === 'gif' && spotlight ? [entry, spotlight] : [entry]))
  }
  const toolButton = (key: ToolAction) => key === 'shape' ? <ShapeButton key={key} scene={scene} disabled={busy} below={panelBelow} onSelect={() => setMore(false)} /> : <ToolButton key={key} name={key} active={scene.tool === key} disabled={busy || (key === 'undo' && !scene.history.canUndo) || (key === 'redo' && !scene.history.canRedo)} onClick={() => select(key)} />
  return <div className="jt-toolbar-anchor" data-capture-interactive style={{ left: at.x, top: at.y, transform: `scale(${scale})`, '--jt-accent': String(scene.snapshot.options.theme_color) } as CSSProperties}>
    <div className="jt-toolbar jt-panel" role="toolbar" aria-label="截图工具条">
      <div className="jt-grip" title="拖动工具条；双击恢复位置" onPointerDown={startDrag} onDoubleClick={() => setManual(null)}><GripVertical size={12} strokeWidth={1.6} aria-hidden="true" /></div>
      {shown.map(entry => toolButton(entry.key))}
      {!fixedLayout && <button type="button" className="jt-more" aria-label="更多工具" aria-expanded={more} onMouseEnter={() => setMore(true)} onClick={() => setMore(true)}>⋮</button>}
    </div>
    {scene.tool !== 'cursor' && <div className={`jt-panel-anchor ${panelBelow ? 'below' : 'above'}`}><ToolPanel scene={scene} /></div>}
    {more && <div className={`jt-more-popup jt-panel ${menuBelow ? 'below' : 'above'}`} onMouseLeave={() => setMore(false)}>
      <div>{hidden.map(entry => toolButton(entry.key))}</div><button type="button" className="jt-adjust" onClick={() => { setEditing(true); setMore(false) }}>调整工具栏…</button>
    </div>}
    {editing && <div className="jt-layout-dialog jt-panel" role="dialog" aria-label="调整工具栏">
      <strong>调整工具栏</strong><p>排序、收起或隐藏按钮；聚光灯随录制按钮排列。</p>
      <div className="jt-layout-list">{layout.map(entry => <div key={entry.key}><CaptureIcon name={entry.key} /><span>{toolLabels[entry.key]?.split('（')[0]}</span>
        <button type="button" aria-label={`上移${toolLabels[entry.key]}`} disabled={movable.findIndex(item => item.key === entry.key) <= 0} onClick={() => moveEntry(entry.key, -1)}>↑</button>
        <button type="button" aria-label={`下移${toolLabels[entry.key]}`} disabled={movable.findIndex(item => item.key === entry.key) < 0 || movable.findIndex(item => item.key === entry.key) >= movable.length - 1} onClick={() => moveEntry(entry.key, 1)}>↓</button>
        <Choice label={`${toolLabels[entry.key]}显示方式`} value={entry.mode} options={entry.key === 'confirm' || entry.key === 'save' ? [['show', '始终显示']] : [['show', '始终显示'], ['more', '更多菜单'], ['hide', '隐藏']]} onChange={value => updateLayout(layout.map(item => item.key === entry.key ? { ...item, mode: value as LayoutEntry['mode'] } : item))} />
      </div>)}</div><footer><button type="button" onClick={() => updateLayout(defaultLayout)}>恢复默认</button><button type="button" onClick={() => setEditing(false)}>完成</button></footer>
    </div>}
  </div>
}
