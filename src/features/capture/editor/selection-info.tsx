import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CaptureScene } from './scene'
import type { Rect } from './model'
import { CaptureIcon } from './toolbar'
export function SelectionInfo({ scene, rect, scale, effect, setEffect, refresh }: { scene: CaptureScene; rect: Rect; scale: number; effect: string | null; setEffect: (effect: string | null) => void; refresh: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null), hide = useRef<ReturnType<typeof setTimeout> | null>(null), hold = useRef(false)
  const options = scene.snapshot.options, confirmed = scene.confirmed
  const checked = (name: string) => name === 'rounded' ? !!options.screenshot_rounded_enabled : name === 'border' ? !!options.screenshot_border_enabled : !!scene.lockRatio
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return
    const width = element.offsetWidth * scale, height = 34 * scale, gap = 7 * scale
    let x = Math.max(0, Math.min(rect.x, scene.bounds.width - width)), y = rect.y - height - gap
    if (y < 0) { y = rect.y; if (rect.x - width - gap >= 0) x = rect.x - width - gap; else if (rect.x + rect.width + width + gap <= scene.bounds.width) x = rect.x + rect.width + gap; else { x = Math.max(0, rect.x + 4 * scale); y += 4 * scale } }
    element.style.left = `${x}px`; element.style.top = `${y}px`
  }, [rect.x, rect.y, rect.width, rect.height, scale, confirmed, scene])
  useEffect(() => () => { hold.current = false; if (hide.current) clearTimeout(hide.current) }, [])
  const enter = (name: string) => { if (hide.current) clearTimeout(hide.current); if (checked(name)) setEffect(name) }
  const leave = () => { hide.current = setTimeout(() => setEffect(null), 200) }
  const toggle = (name: string) => { const enable = !checked(name); if (name === 'ratio') scene.setRatio(enable ? rect.width / rect.height : null); else scene.setOption(name === 'rounded' ? 'screenshot_rounded_enabled' : 'screenshot_border_enabled', enable); setEffect(enable ? name : null) }
  const isHeld = () => hold.current
  const pressRefresh = async () => { hold.current = true; await refresh(); await new Promise(resolve => setTimeout(resolve, 300)); while (isHeld()) { await refresh(); await new Promise(resolve => setTimeout(resolve, 30)) } }
  return <div ref={ref} className="jt-selection-info" data-capture-interactive style={{ transform: `scale(${scale})`, pointerEvents: confirmed ? 'auto' : 'none' }}>
    <span><em>{Math.trunc(rect.x + scene.snapshot.bounds.x)},{Math.trunc(rect.y + scene.snapshot.bounds.y)}</em>&nbsp;&nbsp;{Math.trunc(rect.width)} × {Math.trunc(rect.height)} px</span>
    {confirmed && <><i className="jt-info-spacer" />{['rounded', 'ratio', 'border'].map(name => <button type="button" title={{ rounded: '圆角', border: '描边与阴影', ratio: '锁定比例' }[name]} aria-label={{ rounded: '圆角', border: '描边与阴影', ratio: '锁定比例' }[name]} key={name} aria-pressed={checked(name)} onClick={() => toggle(name)} onMouseEnter={() => enter(name)} onMouseLeave={leave}><CaptureIcon name={name} /></button>)}
      <i className="jt-info-separator" /><button type="button" title="刷新背景；长按连续刷新" aria-label="刷新背景" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); void pressRefresh() }} onPointerUp={() => { hold.current = false }} onPointerCancel={() => { hold.current = false }} onLostPointerCapture={() => { hold.current = false }} onBlur={() => { hold.current = false }} onClick={e => { if (e.detail === 0) void refresh() }}><CaptureIcon name="刷新背景" /></button>
    </>}
    {effect && <div className="jt-effect-panel" role="group" aria-label="截图外观" onMouseEnter={() => { if (hide.current) clearTimeout(hide.current) }} onMouseLeave={leave}>
      {effect === 'rounded' && <><input aria-label="圆角半径" type="range" min={0} max={100} value={Number(options.screenshot_rounded_radius)} onChange={e => scene.setOption('screenshot_rounded_radius', Number(e.target.value))} /><output>{Number(options.screenshot_rounded_radius)}</output></>}
      {effect === 'border' && <><select aria-label="截图效果" value={String(options.screenshot_border_mode)} onChange={e => scene.setOption('screenshot_border_mode', e.target.value)}><option value="shadow">阴影</option><option value="border">描边</option></select><input aria-label="效果大小" type="range" min={1} max={50} value={Number(options.screenshot_border_size)} onChange={e => scene.setOption('screenshot_border_size', Number(e.target.value))} /><output>{Number(options.screenshot_border_size)}</output><input aria-label="效果颜色" type="color" value={String(options[options.screenshot_border_mode === 'border' ? 'screenshot_border_color' : 'screenshot_shadow_color'])} onChange={e => scene.setOption(options.screenshot_border_mode === 'border' ? 'screenshot_border_color' : 'screenshot_shadow_color', e.target.value)} /></>}
      {effect === 'ratio' && <select aria-label="选区比例" value={scene.lockRatio ?? 0} onChange={e => { const ratio = Number(e.target.value) || null; scene.setRatio(ratio); if (ratio) { const width = Math.min(rect.width, (scene.bounds.height - rect.y) * ratio); scene.presetSelection({ ...rect, width, height: width / ratio }) } }}><option value={0}>自由比例</option>{![1, 16 / 9, 4 / 3, 9 / 16].includes(scene.lockRatio ?? 0) && <option value={scene.lockRatio ?? ''}>当前比例</option>}<option value={1}>1 : 1</option><option value={16 / 9}>16 : 9</option><option value={4 / 3}>4 : 3</option><option value={9 / 16}>9 : 16</option></select>}
      {effect === 'border' && <label><input type="checkbox" checked={!!options.screenshot_border_persist} onChange={e => scene.setOption('screenshot_border_persist', e.target.checked)} />每次截图保持开启</label>}
    </div>}
  </div>
}
