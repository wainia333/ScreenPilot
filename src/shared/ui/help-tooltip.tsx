import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp } from 'lucide-react'
import './help-tooltip.css'

export function HelpTooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId(), button = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const cancelClose = useCallback(() => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null }, [])
  const show = () => { cancelClose(); setOpen(true) }
  const closeLater = () => {
    cancelClose()
    timer.current = window.setTimeout(() => { if (document.activeElement !== button.current) setOpen(false); timer.current = null }, 140)
  }
  useEffect(() => cancelClose, [cancelClose])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = button.current?.getBoundingClientRect(), box = popup.current?.getBoundingClientRect()
      if (!anchor || !box) return
      const gap = 8, margin = 12, below = anchor.bottom + gap
      const top = below + box.height <= window.innerHeight - margin ? below : anchor.top - gap - box.height
      setPosition({ left: Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin)), top: Math.max(margin, Math.min(top, window.innerHeight - box.height - margin)) })
    }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelClose(); setOpen(false) } }
    place()
    const observer = new ResizeObserver(place)
    if (popup.current) observer.observe(popup.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('keydown', escape, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.removeEventListener('keydown', escape, true) }
  }, [open, cancelClose])
  return <>
    <button ref={button} type="button" className="help-tooltip-button" aria-label={label} aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={closeLater} onFocus={show} onBlur={closeLater} onClick={show}><CircleHelp size={16} strokeWidth={1.7} aria-hidden="true" /></button>
    {open && createPortal(<div ref={popup} id={id} role="tooltip" className="help-tooltip-popup" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }} onMouseEnter={cancelClose} onMouseLeave={closeLater}>{children}</div>, document.body)}
  </>
}
