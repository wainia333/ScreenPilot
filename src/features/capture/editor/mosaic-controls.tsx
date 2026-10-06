import { useLayoutEffect, useRef } from 'react'
import { context2d, canvas } from './render'
const levels = [4, 10, 16, 32], grids = [8, 5, 3, 2]
function Swatch({ index, smooth }: { index: number; smooth: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const source = canvas(44, 44), c = context2d(source); c.fillStyle = '#e8e8e8'; c.fillRect(0, 0, 44, 44); c.fillStyle = '#7a7a7a'; c.beginPath(); c.moveTo(0, 44); c.lineTo(44, 0); c.lineTo(44, 44); c.closePath(); c.fill()
    const grid = grids[index] ?? 2, small = canvas(grid, grid); context2d(small).drawImage(source, 0, 0, grid, grid)
    const out = context2d(ref.current); out.imageSmoothingEnabled = smooth; out.drawImage(small, 0, 0, 44, 44)
  }, [index, smooth])
  return <canvas ref={ref} width={44} height={44} style={{ width: 22, height: 22 }} />
}
export function MosaicStrength({ value, smooth, onChange }: { value: number; smooth: boolean; onChange: (value: number) => void }) {
  return <div className="jt-mosaic-strength" role="group" aria-label="马赛克强度">{levels.map((level, index) => <button type="button" key={level} aria-label={`强度：${['轻微', '中等', '强烈', '最大'][index]}`} title={`强度：${['轻微', '中等', '强烈', '最大'][index]}`} aria-pressed={value === level} onClick={() => onChange(level)}><Swatch index={index} smooth={smooth} /></button>)}</div>
}
