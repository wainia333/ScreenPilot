import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clamp, defaultStyle, type Mark } from './model'
import { context2d, drawMark } from './render'

// Original base_settings_panel.py StepperWidget: 300ms hold, 60ms repeat.
export function Stepper({ value, label, min = 1, max = 99, step = 1, suffix = '', onChange }: { value: number; label: string; min?: number; max?: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  const latest = useRef({ value, onChange }), repeat = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => { latest.current = { value, onChange } }, [value, onChange])
  const stop = () => { if (repeat.current) clearTimeout(repeat.current); repeat.current = null }
  useEffect(() => stop, [])
  const increment = (direction: number) => { const next = clamp(latest.current.value + direction * step, min, max); latest.current.value = next; latest.current.onChange(next) }
  const hold = (direction: number) => { stop(); increment(direction); repeat.current = setTimeout(function again() { increment(direction); repeat.current = setTimeout(again, 60) }, 300) }
  return <div className={`jt-stepper ${suffix ? 'jt-stepper-suffix' : ''}`} title={label} onWheel={e => increment(e.deltaY < 0 ? 1 : -1)}>
    <label><span className="jt-sr-only">{label}</span><input aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(n, min, max)) }} />{suffix && <span>{suffix}</span>}</label>
    <div>{[1, -1].map(direction => <button key={direction} type="button" aria-label={`${direction > 0 ? '增加' : '减少'}${label}`} onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); hold(direction) }} onPointerUp={stop} onPointerCancel={stop} onClick={e => { if (e.detail === 0) increment(direction) }}><svg viewBox="0 0 9 5" aria-hidden="true"><path d={direction > 0 ? 'M0 5 4.5 0 9 5Z' : 'M0 0 4.5 5 9 0Z'} /></svg></button>)}</div>
  </div>
}
export function StylePreview({ kind, value }: { kind: 'arrow' | 'line' | 'number'; value: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const c = context2d(ref.current); c.clearRect(0, 0, 160, 44); c.save(); c.scale(2, 2)
    if (kind === 'line') { c.strokeStyle = '#444'; c.lineWidth = 2; c.setLineDash(value === 'solid' ? [] : value === 'dashed' ? [8, 5] : [2, 4]); c.beginPath(); c.moveTo(6, 11); c.lineTo(74, 11); c.stroke() }
    else {
      const mark: Mark = { id: 'preview', tool: kind, points: kind === 'arrow' ? [{ x: 6, y: 11 }, { x: 74, y: 11 }] : [{ x: 11, y: 11 }, { x: 11, y: 11 }], rotation: 0, number: 1, style: { ...defaultStyle(kind), color: '#444444', width: kind === 'arrow' ? 3 : 9, arrow: value, number: value as Mark['style']['number'] } }
      drawMark(c, mark, ref.current)
    }
    c.restore()
  }, [kind, value])
  return <canvas ref={ref} width={kind === 'number' ? 44 : 160} height={44} style={{ width: kind === 'number' ? 22 : 80, height: 22 }} aria-hidden="true" />
}
export function PreviewChoice({ label, value, options, kind, onChange }: { label: string; value: string; options: [string, string][]; kind: 'arrow' | 'line' | 'number'; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false), [above, setAbove] = useState(false), [focus, setFocus] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keep = () => { if (timer.current) clearTimeout(timer.current) }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: globalThis.PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close)
  }, [open])
  const show = () => { const r = ref.current?.getBoundingClientRect(); setAbove(!!r && window.innerHeight - r.bottom < options.length * 26 * window.devicePixelRatio && r.top > window.innerHeight - r.bottom); setFocus(Math.max(0, options.findIndex(([key]) => key === value))); setOpen(true) }
  return <div ref={ref} className={`jt-preview-choice ${kind === 'number' ? 'jt-number-choice' : ''}`} onMouseEnter={() => { if (kind === 'number') { keep(); show() } }} onMouseLeave={() => { if (kind === 'number') { keep(); timer.current = setTimeout(() => setOpen(false), 260) } }}>
    <button type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`jt-options-${kind}`} title={options.find(([key]) => key === value)?.[1] ?? label} onClick={() => { if (open) setOpen(false); else show() }} onKeyDown={e => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) show(); else setFocus(v => (v + options.length + (e.key === 'ArrowDown' ? 1 : -1)) % options.length) }
      if (e.key === 'Enter' && open) { e.preventDefault(); e.stopPropagation(); const next = options[focus]; if (next) onChange(next[0]); setOpen(false) }
    }}><StylePreview kind={kind} value={value} /></button>
    {open && <div id={`jt-options-${kind}`} role="listbox" aria-label={label} className={`jt-preview-options jt-panel ${above ? 'above' : 'below'}`} data-capture-interactive>{options.map(([key, text], i) => <button type="button" role="option" aria-label={text} aria-selected={key === value} data-focused={focus === i} key={key} title={text} onMouseEnter={() => setFocus(i)} onClick={() => { onChange(key); setOpen(false) }}><StylePreview kind={kind} value={key} /></button>)}</div>}
  </div>
}
export function ModeButtons({ label, value, options, onChange }: { label: string; value: string; options: { value: string; title: string; icon: ReactNode }[]; onChange: (value: string) => void }) {
  return <div className="jt-mode-buttons" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} aria-label={option.title} title={option.title} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.icon}</button>)}</div>
}
