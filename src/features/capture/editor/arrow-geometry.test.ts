import { expect, it } from 'vitest'
import fc from 'fast-check'
import { arrowGeometry } from './arrow-geometry'
import { defaultStyle, type Mark } from './model'
it('keeps all nine arrow styles finite through short, reversed and curved control points', () => {
  const point = fc.record({ x: fc.integer({ min: -2000, max: 4000 }), y: fc.integer({ min: -2000, max: 4000 }) })
  fc.assert(fc.property(point, point, point, fc.integer({ min: 1, max: 99 }), (a, b, control, width) => {
    for (const arrow of ['single', 'double', 'hollow', 'line', 'line_double', 'triangle', 'triangle_double', 'bar', 'bar_arrow']) {
      const mark: Mark = { id: 'geometry', tool: 'arrow', rotation: 0, points: [a, b, control], style: { ...defaultStyle('arrow'), arrow, width } }
      const geometry = arrowGeometry(mark)
      expect(Object.values(geometry.bounds).every(Number.isFinite)).toBe(true)
      expect(geometry.bounds.width).toBeGreaterThanOrEqual(0); expect(geometry.bounds.height).toBeGreaterThanOrEqual(0)
      for (const p of geometry.rings.flat()) { expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true) }
    }
  }), { numRuns: 70, seed: 20261004 })
  for (const arrow of ['single', 'double', 'hollow', 'line', 'line_double', 'triangle', 'triangle_double', 'bar', 'bar_arrow']) {
    const mark: Mark = { id: 'collapsed', tool: 'arrow', rotation: 0, points: [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }], style: { ...defaultStyle('arrow'), arrow } }
    expect(Object.values(arrowGeometry(mark).bounds).every(Number.isFinite)).toBe(true)
  }
}, 30000)
