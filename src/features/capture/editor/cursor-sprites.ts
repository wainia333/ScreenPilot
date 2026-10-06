// Direct geometry port of gif/cursor_overlay.py::rasterize_cursor_sprites.
import cursorUrl from '../assets/鼠标.svg'
import { canvas, context2d } from './render'
export async function cursorSprites(color: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}, cursor = new Image(); cursor.src = cursorUrl; await cursor.decode()
  const arrow = canvas(24, 24); context2d(arrow).drawImage(cursor, 0, 0, 24, 24); result.cursor = arrow.toDataURL()
  for (const side of ['left', 'right']) for (let frame = 1; frame <= 3; frame++) {
    const c = canvas(80, 80), p = context2d(c), radius = 10 + (frame - 1) * 9
    p.fillStyle = color; p.strokeStyle = color; p.globalAlpha = Math.max(60, 240 - (frame - 1) * 80) / 255
    p.beginPath(); p.arc(40, 40, 6, 0, Math.PI * 2); p.fill(); p.lineWidth = 2.5; p.lineCap = 'round'; p.beginPath()
    for (const degrees of side === 'left' ? [135, 180, 225, 270, 315] : [-45, 0, 45, 90, 135]) { const angle = degrees * Math.PI / 180; p.moveTo(40 + 9 * Math.cos(angle), 40 + 9 * Math.sin(angle)); p.lineTo(40 + radius * Math.cos(angle), 40 + radius * Math.sin(angle)) }
    p.stroke(); result[`burst_${side}_${frame}`] = c.toDataURL()
  }
  for (const direction of [1, -1]) {
    const c = canvas(19, 41), p = context2d(c); p.fillStyle = color
    for (let index = 0; index < 3; index++) { const y = 20 + (index - 1) * 14; p.globalAlpha = Math.max(60, direction === 1 ? 80 + index * 70 : 220 - index * 70) / 255; p.beginPath(); p.moveTo(9, y - direction * 9); p.lineTo(2, y); p.lineTo(16, y); p.closePath(); p.fill() }
    result[direction === 1 ? 'scroll_up' : 'scroll_down'] = c.toDataURL()
  }
  return result
}
