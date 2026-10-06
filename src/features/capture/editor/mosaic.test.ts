import { expect, it } from 'vitest'
import { reduceMosaic } from './mosaic'
it('averages partial blocks without mixing adjacent blocks and repeats boundary pixels', () => {
  const source = new Uint8ClampedArray(5 * 3 * 4)
  for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) source.set([x * 40, y * 60, 0, 255], (y * 5 + x) * 4)
  const result = reduceMosaic(source, 5, 3, 2)
  const pixel = (x: number, y: number) => [...result.data.slice((y * result.width + x) * 4, (y * result.width + x + 1) * 4)]
  expect([result.width, result.height]).toEqual([5, 4]); expect(pixel(1, 1)).toEqual([20, 30, 0, 255]); expect(pixel(3, 2)).toEqual([160, 120, 0, 255])
  expect(pixel(4, 3)).toEqual(pixel(3, 2)); expect(pixel(0, 0)).toEqual(pixel(1, 1))
})
