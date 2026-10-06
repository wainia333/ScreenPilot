import type { Rect } from './model'

// Native window shape and mouse regions are deliberately separate. A live
// recording displays annotations but lets clicks through to the app beneath.
export function captureWindowRegions(bounds: Rect, selection: Rect | null, panels: Rect[], mode: 'capture' | 'live' | 'scroll' | 'draw' | 'playback', visuals: Rect[] = []) {
  if (mode === 'capture') return { regions: [bounds], surface: null, passthrough: false }
  const clip = (r: Rect): Rect | null => {
    const x = Math.max(bounds.x, r.x), y = Math.max(bounds.y, r.y)
    const right = Math.min(bounds.x + bounds.width, r.x + r.width), bottom = Math.min(bounds.y + bounds.height, r.y + r.height)
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
  }
  const visible = panels.map(clip).filter((r): r is Rect => r !== null)
  if (mode === 'scroll') {
    // A real HWND hole, not merely transparent canvas pixels. Keep the border
    // outside the sampled rectangle so neither GDI nor HDR sees capture chrome.
    const ring = selection ? [
      { x: selection.x - 8, y: selection.y - 8, width: selection.width + 16, height: 8 },
      { x: selection.x - 8, y: selection.y + selection.height, width: selection.width + 16, height: 8 },
      { x: selection.x - 8, y: selection.y, width: 8, height: selection.height },
      { x: selection.x + selection.width, y: selection.y, width: 8, height: selection.height },
    ].map(clip).filter((r): r is Rect => r !== null) : []
    return { surface: [...ring, ...visible, ...visuals.map(clip).filter((r): r is Rect => r !== null)], regions: visible, passthrough: true, scroll: true }
  }
  const picture = selection && clip({ x: selection.x - 8, y: selection.y - 8, width: selection.width + 16, height: selection.height + 16 })
  const interactive = picture ? [picture, ...visible] : visible
  const surface = [...interactive, ...visuals.map(clip).filter((r): r is Rect => r !== null)]
  return { surface, regions: mode === 'live' ? visible : interactive, passthrough: mode === 'live' }
}
