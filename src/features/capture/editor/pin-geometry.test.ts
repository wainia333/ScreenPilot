import { describe, expect, it } from 'vitest'
import { cropCenter, mapPinPoint, originalTransform, pinEdgeRect, pinEdges, pinSize, regionCrop, resizePin, thumbnailCrop } from './pin-geometry'
describe('upstream pin image transforms and thumbnail geometry', () => {
  it('round-trips annotation coordinates for all rotations, flips and fractional zooms', () => {
    for (const rotation of [0, 90, 180, 270]) for (const flipH of [false, true]) for (const flipV of [false, true]) for (const zoom of [0.15, 1, 1.25, 3.7]) {
      const view = { rotation, flipH, flipV, zoom }
      for (const p of [{ x: 0, y: 0 }, { x: 160, y: 120 }, { x: 76.8, y: 39.2 }]) {
        const output = mapPinPoint(mapPinPoint(p, 160, 120, view), 160, 120, view, true)
        expect(output.x).toBeCloseTo(p.x, 9); expect(output.y).toBeCloseTo(p.y, 9)
      }
    }
  })
  it('keeps a 100 by 100 original-pixel crop, with edge clamping instead of scaling the whole image', () => {
    const crop = thumbnailCrop({ x: 790, y: 580 }, 800, 600)
    expect(crop.rect).toEqual({ x: 700, y: 500, width: 100, height: 100 })
    expect(pinSize(800, 600, { ...originalTransform, zoom: 2 }, crop)).toEqual({ width: 100, height: 100 })
    expect(cropCenter(crop)).toEqual({ x: 750, y: 550 })
    expect(thumbnailCrop({ x: 5, y: 5 }, 40, 30).rect).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })
  it('retains a custom cropped region at current zoom and discards clicks/tiny regions', () => {
    expect(regionCrop({ x: -10, y: 20, width: 120, height: 60 }, 800, 600, 1.25)).toEqual({ rect: { x: 0, y: 20, width: 110, height: 60 }, scale: 1.25 })
    expect(regionCrop({ x: 10, y: 20, width: 1, height: 60 }, 800, 600, 1)).toBeNull()
  })
  it('keeps the opposite corner or side midpoint fixed for all eight proportional resize directions', () => {
    const size = { width: 480, height: 320 }
    for (const edge of pinEdges) {
      const dx = edge.includes('e') ? 96 : edge.includes('w') ? -96 : 0
      const dy = edge.includes('s') ? 64 : edge.includes('n') ? -64 : 0
      const next = resizePin(edge, size, { x: dx, y: dy }, 0.1, 8)
      expect(next.scale).toBeCloseTo(1.2)
      const opposite = { x: edge.includes('w') ? 1 : edge.includes('e') ? 0 : 0.5, y: edge.includes('n') ? 1 : edge.includes('s') ? 0 : 0.5 }
      expect(next.shift.x + Math.round(size.width * next.scale) * opposite.x).toBeCloseTo(size.width * opposite.x)
      expect(next.shift.y + Math.round(size.height * next.scale) * opposite.y).toBeCloseTo(size.height * opposite.y)
    }
    expect(resizePin('nw', size, { x: 10000, y: 10000 }, 0.2, 8).scale).toBe(0.2)
    expect(resizePin('se', size, { x: 10000, y: 10000 }, 0.2, 8).scale).toBe(8)
  })
  it('offers transparent edge targets at every DPI without blocking the image interior', () => {
    for (const ratio of [1, 1.25, 1.5, 2]) for (const edge of pinEdges) {
      const r = pinEdgeRect(edge, { width: 480, height: 320 }, ratio)
      expect(r.width).toBeGreaterThan(0); expect(r.height).toBeGreaterThan(0)
      expect(240 >= r.x && 240 <= r.x + r.width && 160 >= r.y && 160 <= r.y + r.height).toBe(false)
    }
  })
})
