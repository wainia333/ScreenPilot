// Pin image transforms and thumbnail geometry.
import { clamp, clipRect, type Point, type Rect } from './model'
export type PinTransform = { zoom: number; rotation: number; flipH: boolean; flipV: boolean }
export type PinCrop = { rect: Rect; scale: number }
export const originalTransform: PinTransform = { zoom: 1, rotation: 0, flipH: false, flipV: false }
export type PinEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
export const pinEdges: PinEdge[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
export function pinEdgeRect(edge: PinEdge, size: { width: number; height: number }, ratio: number): Rect {
  const corner = Math.min(8 * ratio, Math.min(size.width, size.height) / 3), band = Math.min(4 * ratio, corner)
  const horizontal = edge.includes('e') ? 1 : edge.includes('w') ? -1 : 0
  const vertical = edge.includes('s') ? 1 : edge.includes('n') ? -1 : 0
  return {
    x: horizontal === 1 ? size.width - (vertical ? corner : band) : horizontal === -1 ? -band : corner,
    y: vertical === 1 ? size.height - (horizontal ? corner : band) : vertical === -1 ? -band : corner,
    width: horizontal === 0 ? size.width - corner * 2 : vertical === 0 ? band * 2 : corner + band,
    height: vertical === 0 ? size.height - corner * 2 : horizontal === 0 ? band * 2 : corner + band,
  }
}
// Side drags keep the opposite side's midpoint fixed; corners keep the opposite
// corner fixed. Project diagonal movement onto the aspect-ratio diagonal.
export function resizePin(edge: PinEdge, size: { width: number; height: number }, delta: Point, min: number, max: number) {
  const horizontal = edge.includes('e') ? 1 : edge.includes('w') ? -1 : 0
  const vertical = edge.includes('s') ? 1 : edge.includes('n') ? -1 : 0
  const growth = horizontal && vertical
    ? (delta.x * horizontal * size.width + delta.y * vertical * size.height) / (size.width ** 2 + size.height ** 2)
    : horizontal ? delta.x * horizontal / size.width : delta.y * vertical / size.height
  const scale = clamp(1 + growth, min, max)
  const width = Math.round(size.width * scale), height = Math.round(size.height * scale)
  return { scale, shift: { x: (size.width - width) * (horizontal === -1 ? 1 : horizontal === 0 ? 0.5 : 0), y: (size.height - height) * (vertical === -1 ? 1 : vertical === 0 ? 0.5 : 0) } }
}
export function pinSize(width: number, height: number, view: PinTransform, crop: PinCrop | null) {
  if (crop) return { width: crop.rect.width * crop.scale, height: crop.rect.height * crop.scale }
  return view.rotation % 180 ? { width: height * view.zoom, height: width * view.zoom } : { width: width * view.zoom, height: height * view.zoom }
}
export function mapPinPoint(p: Point, width: number, height: number, view: PinTransform, inverse = false): Point {
  const size = pinSize(width, height, view, null), angle = view.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  if (inverse) {
    const x = (p.x - size.width / 2) / view.zoom * (view.flipH ? -1 : 1), y = (p.y - size.height / 2) / view.zoom * (view.flipV ? -1 : 1)
    return { x: x * cos + y * sin + width / 2, y: -x * sin + y * cos + height / 2 }
  }
  const x = p.x - width / 2, y = p.y - height / 2
  return { x: (x * cos - y * sin) * (view.flipH ? -1 : 1) * view.zoom + size.width / 2, y: (x * sin + y * cos) * (view.flipV ? -1 : 1) * view.zoom + size.height / 2 }
}
export function thumbnailCrop(p: Point, width: number, height: number): PinCrop {
  // Upstream displays a 100px square at 1:1; small sources leave empty space.
  return { rect: { x: clamp(p.x - 50, 0, Math.max(0, width - 100)), y: clamp(p.y - 50, 0, Math.max(0, height - 100)), width: 100, height: 100 }, scale: 1 }
}
export function regionCrop(rect: Rect, width: number, height: number, scale: number): PinCrop | null {
  const clipped = clipRect(rect, { x: 0, y: 0, width, height })
  return clipped.width >= 3 && clipped.height >= 3 ? { rect: clipped, scale } : null
}
export function cropCenter(crop: PinCrop): Point { return { x: crop.rect.x + crop.rect.width / 2, y: crop.rect.y + crop.rect.height / 2 } }
