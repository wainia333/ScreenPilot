import { useEffect, useRef, useState } from 'react'
import type { Style } from './model'
const levels = [0.04, 0.07, 0.12, 0.2]
export function TextEffects({ style, onChange }: { style: Style; onChange: (patch: Partial<Style>) => void }) {
  const [open, setOpen] = useState<string | null>(null), [above, setAbove] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keep = () => { if (timer.current) clearTimeout(timer.current) }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return <div className="jt-text-effects" onMouseEnter={keep} onMouseLeave={() => { keep(); timer.current = setTimeout(() => setOpen(null), 260) }}>
    {(['background', 'outline', 'shadow'] as const).map((key, i) => {
      const label = ['背景', '描边', '阴影'][i] ?? key, color = style[`${key}Color`], opacity = color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255
      const setColor = (value: string) => onChange({ [`${key}Color`]: value.slice(0, 7) + (key === 'outline' ? '' : opacity.toString(16).padStart(2, '0')) })
      return <div className="jt-text-effect" key={key}>
        <button type="button" aria-label={label} title={label} aria-pressed={style[key]} onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setAbove(r.bottom + 100 > window.innerHeight); if (style[key]) setOpen(key) }} onClick={() => { onChange({ [key]: !style[key] }); setOpen(style[key] ? null : key) }}>{key === 'background' ? 'BG' : <span className={`jt-text-effect-icon ${key}`}>T</span>}</button>
        {open === key && <div className={`jt-text-effect-popup jt-panel ${above ? 'above' : 'below'}`} data-capture-interactive>
          <div className="jt-effect-colors"><input type="color" title={`自定义${label}颜色`} aria-label={`${label}颜色`} value={color.slice(0, 7)} onChange={e => setColor(e.target.value)} />{['#FFFFFF', '#000000', '#FFFF00'].map(c => <button type="button" key={c} aria-label={`${label}${{ '#FFFFFF': '白色', '#000000': '黑色', '#FFFF00': '黄色' }[c]}`} style={{ background: c }} onClick={() => setColor(c)} />)}</div>
          <div className="jt-effect-amount">{key === 'outline' ? <><span className="jt-text-effect-icon outline">T</span><input type="range" aria-label="文字描边粗细" min={0} max={3} step={1} value={Math.max(0, levels.indexOf(style.outlineWidth))} onChange={e => onChange({ outlineWidth: levels[Number(e.target.value)] ?? 0.07 })} /><b className="jt-text-effect-icon outline">T</b></> : <><input type="range" aria-label={`${label}不透明度`} min={0} max={255} value={opacity} onChange={e => onChange({ [`${key}Color`]: color.slice(0, 7) + Number(e.target.value).toString(16).padStart(2, '0') })} /><output>{Math.round(opacity / 255 * 100)}%</output></>}</div>
        </div>}
      </div>
    })}
  </div>
}
