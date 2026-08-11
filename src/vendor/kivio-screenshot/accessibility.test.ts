import { describe, expect, it } from 'vitest'
import {
  adjustKeyboardArrow,
  adjustKeyboardRegion,
  defaultKeyboardArrow,
  defaultKeyboardRegion,
  nextWindowIndex,
} from './accessibility'

describe('Vision keyboard selection geometry', () => {
  it('creates and clamps a centered region', () => {
    expect(defaultKeyboardRegion({ w: 1000, h: 600 })).toEqual({ x: 250, y: 150, width: 500, height: 300 })
    const moved = adjustKeyboardRegion(
      { x: 0, y: 0, width: 500, height: 300 },
      { w: 1000, h: 600 },
      'ArrowLeft',
      false,
    )
    expect(moved.x).toBe(0)
    expect(adjustKeyboardRegion(moved, { w: 1000, h: 600 }, 'ArrowRight', false).x).toBe(10)
  })

  it('resizes without leaving the viewport and cycles windows', () => {
    const resized = adjustKeyboardRegion(
      { x: 900, y: 500, width: 100, height: 100 },
      { w: 1000, h: 600 },
      'ArrowRight',
      true,
    )
    expect(resized.width).toBe(100)
    expect(nextWindowIndex(3, 2, 1)).toBe(0)
    expect(nextWindowIndex(3, 0, -1)).toBe(2)
  })

  it('creates, adjusts, and pans a keyboard arrow inside the image', () => {
    const arrow = defaultKeyboardArrow({ w: 200, h: 100 })
    expect(arrow).toEqual({ x1: 50, y1: 65, x2: 150, y2: 35 })
    expect(adjustKeyboardArrow(arrow, { w: 200, h: 100 }, 'ArrowRight', false).x2).toBe(160)
    expect(adjustKeyboardArrow(arrow, { w: 200, h: 100 }, 'ArrowLeft', true)).toEqual({
      x1: 40,
      y1: 65,
      x2: 140,
      y2: 35,
    })
    expect(adjustKeyboardArrow({ x1: 0, y1: 10, x2: 100, y2: 20 }, { w: 100, h: 100 }, 'ArrowLeft', true))
      .toEqual({ x1: 0, y1: 10, x2: 100, y2: 20 })
  })
})
