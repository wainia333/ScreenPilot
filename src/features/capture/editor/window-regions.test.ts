import { expect, it } from 'vitest'
import { captureWindowRegions } from './window-regions'

it('limits playback to the preview and controls instead of blocking the desktop', () => {
  const bounds = { x: -1920, y: -100, width: 3840, height: 1200 }
  const selection = { x: -1700, y: 20, width: 600, height: 400 }
  const toolbar = { x: -1600, y: 430, width: 500, height: 80 }, notice = { x: -1200, y: -90, width: 300, height: 35 }
  const playback = captureWindowRegions(bounds, selection, [toolbar, notice], 'playback')
  expect(playback.passthrough).toBe(false)
  expect(playback.regions).toEqual(playback.surface)
  expect(playback.surface).toContainEqual(notice)
  expect(playback.surface).not.toContainEqual(bounds)
  const live = captureWindowRegions(bounds, selection, [toolbar], 'live')
  expect(live.passthrough).toBe(true)
  expect(live.regions).toEqual([toolbar])
  expect(live.surface).toHaveLength(2)
  expect(captureWindowRegions(bounds, selection, [], 'capture')).toEqual({ regions: [bounds], surface: null, passthrough: false })
})

it('clips shaped windows to the virtual desktop and discards offscreen elements', () => {
  const bounds = { x: 0, y: 0, width: 640, height: 480 }
  const value = captureWindowRegions(bounds, bounds, [{ x: 630, y: 470, width: 50, height: 50 }, { x: 900, y: 500, width: 20, height: 20 }], 'draw')
  expect(value.surface).toEqual([bounds, { x: 630, y: 470, width: 10, height: 10 }])
})

it('includes a scroll thumbnail in the visible surface while keeping it out of mouse hit regions', () => {
  const bounds = { x: -1920, y: 0, width: 3840, height: 1080 }
  const selection = { x: -1600, y: 150, width: 700, height: 500 }
  const thumbnail = { x: -850, y: 150, width: 190, height: 700 }
  const toolbar = { x: -1300, y: 670, width: 292, height: 40 }
  const value = captureWindowRegions(bounds, selection, [toolbar], 'scroll', [thumbnail])
  expect(value.surface).toContainEqual(thumbnail)
  expect(value.regions).toEqual([toolbar])
  expect(value.scroll).toBe(true)
  expect(value.surface?.every(r => r.x >= selection.x + selection.width || r.x + r.width <= selection.x || r.y >= selection.y + selection.height || r.y + r.height <= selection.y)).toBe(true)
})

it('keeps the entire scroll selection hollow at screen edges and on negative-coordinate monitors', () => {
  const bounds = { x: -1920, y: -180, width: 3840, height: 1260 }
  for (const selection of [bounds, { x: -1920, y: -180, width: 800, height: 600 }, { x: 100, y: 50, width: 640, height: 400 }]) {
    const value = captureWindowRegions(bounds, selection, [], 'scroll')
    expect(value.regions).toEqual([])
    expect(value.passthrough).toBe(true)
    for (const r of value.surface ?? []) {
      expect(r.width).toBeGreaterThan(0); expect(r.height).toBeGreaterThan(0)
      expect(r.x >= selection.x + selection.width || r.x + r.width <= selection.x || r.y >= selection.y + selection.height || r.y + r.height <= selection.y).toBe(true)
    }
  }
})
