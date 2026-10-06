import { context2d } from './render'
import { clamp, type Point } from './model'
import { colorFormats, formatColor } from '../color-formats'
export function pixelColor(background: HTMLCanvasElement, point: Point, raw?: unknown, index = 0) {
  const pixel = context2d(background, true).getImageData(clamp(Math.floor(point.x), 0, background.width - 1), clamp(Math.floor(point.y), 0, background.height - 1), 1, 1).data
  const enabled = colorFormats(raw).filter(item => item.enabled), name = enabled[index % enabled.length]?.name ?? 'RGB'
  return { hex: formatColor(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, 'HEX'), value: formatColor(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, name) }
}
