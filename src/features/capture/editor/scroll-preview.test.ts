import { expect, it } from 'vitest'
import { scrollPreviewRect } from './scroll-preview'

it('grows upwards at constant width or rightwards at constant height with a fixed anchor', () => {
  const screen = { x: -1000, y: -200, width: 1280, height: 800 }, region = { x: -840, y: -50, width: 700, height: 400 }
  for (const scale of [0.75, 1, 1.25, 1.5, 2]) for (const horizontal of [false, true]) {
    const sizes = [0, 180, 540, 4000, 28000].map(extra => scrollPreviewRect(region, screen, { width: 700 + (horizontal ? extra : 0), height: 400 + (horizontal ? 0 : extra) }, horizontal, scale))
    const first = sizes[0]
    if (!first) throw new Error('Missing initial preview')
    for (const [i, rect] of sizes.entries()) {
      const previous = sizes[i - 1]
      expect(rect.x).toBe(first.x)
      if (horizontal) {
        expect(rect.height).toBe(first.height); expect(rect.y).toBe(first.y)
        if (previous) expect(rect.width).toBeGreaterThanOrEqual(previous.width)
      } else {
        expect(rect.width).toBe(first.width); expect(rect.y + rect.height).toBeCloseTo(first.y + first.height)
        if (previous) expect(rect.y).toBeLessThanOrEqual(previous.y)
      }
    }
  }
})

it('keeps very long portrait and landscape previews inside their monitor at every UI scale', () => {
  const screen = { x: -1920, y: -240, width: 1920, height: 1080 }
  for (const scale of [0.75, 1, 1.25, 1.5, 2]) for (const horizontal of [false, true]) {
    for (const length of [400, 4000, 32000, 100000]) {
      const region = { x: -1500, y: 100, width: 700, height: 400 }
      const image = horizontal ? { width: length, height: 400 } : { width: 700, height: length }
      const rect = scrollPreviewRect(region, screen, image, horizontal, scale)
      expect(rect.width).toBeGreaterThan(0); expect(rect.height).toBeGreaterThan(0)
      expect(rect.x).toBeGreaterThanOrEqual(screen.x); expect(rect.y).toBeGreaterThanOrEqual(screen.y)
      expect(rect.x + rect.width).toBeLessThanOrEqual(screen.x + screen.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(screen.y + screen.height)
    }
  }
})

it('uses the adjacent space first and handles a small monitor or fullscreen selection without offscreen bounds', () => {
  const screen = { x: 320, y: 20, width: 240, height: 180 }
  for (const region of [screen, { x: 330, y: 25, width: 20, height: 50 }]) {
    const rect = scrollPreviewRect(region, screen, { width: 700, height: 32000 }, false, 2)
    expect(rect.x).toBeGreaterThanOrEqual(screen.x)
    expect(rect.y).toBeGreaterThanOrEqual(screen.y)
    expect(rect.x + rect.width).toBeLessThanOrEqual(screen.x + screen.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(screen.y + screen.height)
  }
})
