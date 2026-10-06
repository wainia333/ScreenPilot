import { canvas, context2d, drawSelectionFrame, framePadding } from './render'
import { pinSize, type PinCrop, type PinTransform } from './pin-geometry'
import type { Rect, SelectionFrame } from './model'

export function drawPinFrame(c: CanvasRenderingContext2D, rect: Rect, frame: SelectionFrame) {
  // Use the same rounded-rectangle distance field as the native renderer.
  // The entire rim has one colour and a continuous outward alpha falloff;
  // there is no opaque outline or separate black shadow.
  const padding = 12, width = Math.round(rect.width), height = Math.round(rect.height)
  const radius = Math.min(frame.radius, width / 2, height / 2)
  const pixels = c.createImageData(width + padding * 2, height + padding * 2)
  const rgb = [1, 3, 5].map(at => Number.parseInt(frame.color.slice(at, at + 2), 16))
  for (let y = 0; y < pixels.height; y++) {
    const py = y - padding + 0.5
    for (let x = 0; x < pixels.width; x++) {
      const px = x - padding + 0.5
      if (py >= radius && py <= height - radius && x === padding) { x = padding + width - 1; continue }
      if (px >= 0 && px < width && py >= 0 && py < height && (px >= radius && px <= width - radius || py >= radius && py <= height - radius)) continue
      const qx = Math.abs(px - width / 2) - (width / 2 - radius), qy = Math.abs(py - height / 2) - (height / 2 - radius)
      const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      if (distance < 0) continue
      const taper = Math.max(0, Math.min(1, (8 - distance) / 3))
      const alpha = Math.round(150 * Math.exp(-((distance / 2.8) ** 2) / 2) * taper * taper * (3 - 2 * taper))
      const at = (y * pixels.width + x) * 4
      pixels.data[at] = rgb[0] ?? 0; pixels.data[at + 1] = rgb[1] ?? 0; pixels.data[at + 2] = rgb[2] ?? 0; pixels.data[at + 3] = alpha
    }
  }
  c.putImageData(pixels, Math.round(rect.x) - padding, Math.round(rect.y) - padding)
}

// Render in physical pixels once. CSS/WebView DPI transforms affect controls only.
export function pinPixels(document: HTMLCanvasElement, chrome: HTMLCanvasElement, view: PinTransform, crop: PinCrop | null, frame: SelectionFrame | null | undefined, options: { rounded: boolean; color: string }, opacity: number, retained = false) {
  const size = pinSize(document.width, document.height, view, crop)
  const padding = retained && frame ? framePadding(frame) : 12
  const result = canvas(Math.ceil(size.width) + padding * 2, Math.ceil(size.height) + padding * 2), c = context2d(result)
  const rect = { x: padding, y: padding, ...size }, radius = frame?.radius ?? (options.rounded ? 8 : 0)
  if (retained && frame) {
    // Keep the source selection's pixels during the original-position handoff.
    // The continuous pin rim replaces this temporary selection chrome once ready.
    drawSelectionFrame(c, rect, frame)
  } else drawPinFrame(c, rect, frame ?? { width: 1, radius, color: options.color })
  c.save(); c.beginPath(); c.roundRect(rect.x, rect.y, rect.width, rect.height, Math.min(radius, size.width / 2, size.height / 2)); c.clip()
  if (crop) { c.translate(padding - crop.rect.x * crop.scale, padding - crop.rect.y * crop.scale); c.scale(crop.scale, crop.scale) }
  else {
    c.translate(padding + size.width / 2, padding + size.height / 2)
    c.scale(view.zoom * (view.flipH ? -1 : 1), view.zoom * (view.flipV ? -1 : 1)); c.rotate(view.rotation * Math.PI / 180)
    c.translate(-document.width / 2, -document.height / 2)
  }
  c.drawImage(document, 0, 0); c.drawImage(chrome, 0, 0); c.restore()
  if (opacity === 1) return { image: result, padding }
  const faded = canvas(result.width, result.height), output = context2d(faded)
  output.globalAlpha = opacity; output.drawImage(result, 0, 0)
  return { image: faded, padding }
}
