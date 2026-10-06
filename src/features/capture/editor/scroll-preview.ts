import { clamp, type Rect } from './model'

// The short side and growth anchor never move. Once the monitor edge is reached,
// the native preview crops the oldest pixels instead of shrinking the full image.
export const previewInset = 7
export function scrollPreviewViewport(region: Rect, screen: Rect, horizontal: boolean, scale: number): Rect {
  const margin = Math.min(14 * scale, screen.width / 8, screen.height / 8)
  const right = screen.x + screen.width - margin, bottom = screen.y + screen.height - margin
  const left = screen.x + margin, top = screen.y + margin
  const side = Math.min(190 * scale, right - left, bottom - top)
  if (horizontal) {
    const x = clamp(region.x, left, right - side)
    const y = region.y - margin - side >= top ? region.y - margin - side
      : region.y + region.height + margin + side <= bottom ? region.y + region.height + margin : bottom - side
    return { x, y, width: right - x, height: side }
  }
  const x = region.x + region.width + margin + side <= right ? region.x + region.width + margin
    : region.x - margin - side >= left ? region.x - margin - side : right - side
  const anchor = clamp(region.y + region.height, top + side, bottom)
  return { x, y: top, width: side, height: anchor - top }
}
export function scrollPreviewRect(region: Rect, screen: Rect, image: { width: number; height: number }, horizontal: boolean, scale: number): Rect {
  const viewport = scrollPreviewViewport(region, screen, horizontal, scale)
  const ratio = Math.max(1, image.width) / Math.max(1, image.height)
  const inset = previewInset * 2
  const width = horizontal ? Math.min(viewport.width, Math.max(inset + 1, (viewport.height - inset) * ratio + inset)) : viewport.width
  const height = horizontal ? viewport.height : Math.min(viewport.height, Math.max(inset + 1, (viewport.width - inset) / ratio + inset))
  return { x: viewport.x, y: horizontal ? viewport.y : viewport.y + viewport.height - height, width, height }
}
