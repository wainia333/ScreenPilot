import { useLayoutEffect, useRef } from 'react'
import type { CaptureScene } from './scene'
import { pixelColor } from './pixel-color'
import { clamp, contains } from './model'
// Preserve upstream sampling and colors, with a larger preview requested by the user.
export function Magnifier({ scene, background, zoom, format, revision, scale }: { scene: CaptureScene; background: HTMLCanvasElement; zoom: number; format: number; revision: number; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null), p = scene.cursor, width = 224, height = 164
  const color = pixelColor(background, p, scene.snapshot.options.magnifier_color_formats, format), hints = !!scene.snapshot.options.magnifier_hint, total = height + (hints ? 94 : 54), margin = 16 * scale
  const screen = scene.snapshot.screens.map(s => ({ ...s, x: s.x - scene.snapshot.bounds.x, y: s.y - scene.snapshot.bounds.y })).find(s => contains(s, p)) ?? scene.bounds
  const displayScale = Math.min(scale, Math.max(0.1, (screen.width - margin * 2) / (width + 2)), Math.max(0.1, (screen.height - margin * 2) / total))
  const x = clamp(p.x + margin + (width + 2) * displayScale > screen.x + screen.width - margin ? p.x - (width + 2) * displayScale - margin : p.x + margin, screen.x + margin, screen.x + screen.width - (width + 2) * displayScale - margin)
  const y = clamp(p.y + margin + total * displayScale > screen.y + screen.height - margin ? p.y - total * displayScale - margin : p.y + margin, screen.y + margin, screen.y + screen.height - total * displayScale - margin)
  useLayoutEffect(() => {
    const c = ref.current?.getContext('2d'); if (!c) return
    const sample = Math.max(Math.floor(48 / zoom), 4) | 1, cell = width / sample, rows = Math.max(3, Math.round(height / cell) | 1), half = Math.floor(sample / 2)
    const left = Math.floor(p.x) - half, top = Math.floor(p.y) - Math.floor(rows / 2)
    c.imageSmoothingEnabled = false; c.clearRect(0, 0, width, height)
    c.drawImage(background, left, top, sample, rows, 0, 0, width, height)
    c.strokeStyle = String(scene.snapshot.options.theme_color ?? '#3388ff'); c.lineWidth = 1
    if (scene.snapshot.options.magnifier_grid && Math.min(cell, height / rows) >= 5) {
      c.globalAlpha = 160 / 255; c.beginPath()
      for (let i = 1; i < sample; i++) { c.moveTo(Math.round(i * cell), 0); c.lineTo(Math.round(i * cell), height) }
      for (let i = 1; i < rows; i++) { c.moveTo(0, Math.round(i * height / rows)); c.lineTo(width, Math.round(i * height / rows)) }
      c.stroke(); c.globalAlpha = 1
    }
    c.lineWidth = 2; c.beginPath(); c.moveTo(Math.floor(width / 2), 0); c.lineTo(Math.floor(width / 2), height); c.moveTo(0, Math.floor(height / 2)); c.lineTo(width, Math.floor(height / 2)); c.stroke()
  }, [background, p.x, p.y, zoom, revision, scene])
  return <div className="jt-magnifier" style={{ left: x, top: y, width: width + 2, transform: `scale(${displayScale})` }}>
    <canvas ref={ref} width={width} height={height} /><b className="jt-magnifier-zoom">{Number.isInteger(zoom * 10) ? zoom.toFixed(1) : zoom.toFixed(2)}x</b>
    <div className="jt-magnifier-info"><div className="jt-magnifier-position">({Math.floor(p.x + scene.snapshot.bounds.x)}, {Math.floor(p.y + scene.snapshot.bounds.y)})</div>
      <div className="jt-magnifier-value"><i style={{ background: color.hex }} /><span>{color.value}</span></div>
      {hints && <><small>Shift: 切换颜色格式</small><small>C: 复制颜色值</small></>}
    </div>
  </div>
}
