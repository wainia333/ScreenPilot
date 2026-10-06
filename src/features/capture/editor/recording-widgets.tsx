// Geometry and behavior ported from gif/playback_toolbar.py and gif/_widgets.py.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { clamp } from './model'

export function RecordingMenu({ label, value, options, disabled, onChange }: { label: string; value: number; options: [string, number][]; disabled?: boolean; onChange: (value: number) => void }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null)
  const [above, setAbove] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: globalThis.PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return <div className="jt-record-menu" ref={root}>
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { const r = root.current?.getBoundingClientRect(); setAbove(!!r && r.bottom + options.length * 28 > window.innerHeight); setOpen(v => !v) }} onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}>{options.find(([, v]) => v === value)?.[0]}</button>
    {open && !disabled && <div role="menu" aria-label={label} className={`jt-record-menu-items ${above ? 'above' : 'below'}`} data-capture-interactive>{options.map(([name, v]) => <button type="button" role="menuitemradio" aria-checked={v === value} key={v} onClick={() => { onChange(v); setOpen(false) }}>{name}</button>)}</div>}
  </div>
}

export function TrimSlider({ total, start, end, frame, disabled, onTrim, onSeek }: { total: number; start: number; end: number; frame: number; disabled?: boolean; onTrim: (start: number, end: number) => void; onSeek: (frame: number) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const last = Math.max(0, total - 1), percent = (index: number) => `${last ? index / last * 100 : 0}%`, inactive = disabled === true || total === 0
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !total || e.button !== 0) return
    const element = e.currentTarget, rect = element.getBoundingClientRect(), scale = rect.width / element.offsetWidth
    const width = element.offsetWidth - 20, x = (e.clientX - rect.left) / scale - 10, y = (e.clientY - rect.top) / scale
    const at = (index: number) => last ? index / last * width : 0
    const handle = y >= 2 && y <= 30 && Math.abs(x - at(start)) <= 9 ? 'start' : y >= 2 && y <= 30 && Math.abs(x - at(end)) <= 9 ? 'end' : null
    const index = (clientX: number) => Math.round(clamp(((clientX - rect.left) / scale - 10) / Math.max(1, width), 0, 1) * last)
    if (!handle) { onSeek(index(e.clientX)); return }
    element.setPointerCapture(e.pointerId)
    const move = (event: globalThis.PointerEvent) => { const n = index(event.clientX); if (handle === 'start') onTrim(clamp(n, 0, Math.max(0, end - 1)), end); else onTrim(start, clamp(n, Math.min(last, start + 1), last)) }
    const stop = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop) }
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop)
  }
  const keyboard = (e: KeyboardEvent, kind: 'start' | 'end' | 'frame') => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault(); e.stopPropagation()
    const current = kind === 'start' ? start : kind === 'end' ? end : frame
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? last : current + (e.key === 'ArrowLeft' ? -1 : 1)
    if (kind === 'start') onTrim(clamp(next, 0, Math.max(0, end - 1)), end)
    else if (kind === 'end') onTrim(start, clamp(next, Math.min(last, start + 1), last))
    else onSeek(clamp(next, 0, last))
  }
  return <div className="jt-trim-slider" ref={root} onPointerDown={drag}>
    <div className="jt-trim-track"><div className="jt-trim-selection" style={{ left: percent(start), right: percent(last - end) }} /></div>
    <div className="jt-trim-handles">
      {(['start', 'end', 'frame'] as const).map(kind => { const index = kind === 'start' ? start : kind === 'end' ? end : frame; return <div key={kind} className={`jt-trim-handle ${kind}`} role="slider" aria-label={{ start: '起始帧', end: '结束帧', frame: '回放位置' }[kind]} aria-valuemin={kind === 'end' ? Math.min(last, start + 1) : 0} aria-valuemax={kind === 'start' ? Math.max(0, end - 1) : last} aria-valuenow={index} aria-valuetext={`第 ${index + 1} 帧`} aria-disabled={inactive} tabIndex={inactive ? -1 : 0} style={{ left: percent(index) }} onKeyDown={e => keyboard(e, kind)} /> })}
    </div>
  </div>
}
