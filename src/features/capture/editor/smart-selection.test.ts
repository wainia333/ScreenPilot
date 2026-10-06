import { describe, expect, it } from 'vitest'
import { SmartSelectionAnimation } from './smart-selection'
describe('upstream smart selection timing', () => {
  it('snaps initial and small moves; completes a large move in real elapsed time', () => {
    const a = new SmartSelectionAnimation(), rect = { x: 0, y: 0, width: 200, height: 100 }
    a.to(rect, true, 0); expect(a.at(0)).toEqual(rect)
    a.to({ ...rect, x: 4 }, true, 5); expect(a.active).toBe(false)
    a.to({ ...rect, x: 100 }, true, 10); expect(a.at(55)?.x).toBe(88)
    a.to({ ...rect, x: 100 }, true, 60); expect(a.at(100)?.x).toBe(100); expect(a.active).toBe(false)
  })
  it('retargets from current geometry; disabling animation snaps immediately', () => {
    const a = new SmartSelectionAnimation(), rect = { x: 0, y: 0, width: 200, height: 100 }
    a.to(rect, true, 0); a.to({ ...rect, x: 100 }, true, 0)
    const current = a.at(30); a.to({ ...rect, x: 300 }, true, 30); expect(a.at(30)).toEqual(current)
    expect(a.at(120)?.x).toBe(300); a.to(rect, false, 121); expect(a.at(121)).toEqual(rect)
  })
})
