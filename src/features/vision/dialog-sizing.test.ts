import { describe, expect, it } from 'vitest'
import { visionAnswerHeight, visionDialogFrameHeight, visionDialogHeight } from './dialog-sizing'

describe('Vision dialog sizing', () => {
  it.each([
    { viewport: 720, hasScreenshot: true, content: 216, frame: 282 },
    { viewport: 720, hasScreenshot: false, content: 324, frame: 390 },
    { viewport: 400, hasScreenshot: true, content: 147, frame: 213 },
    { viewport: 400, hasScreenshot: false, content: 221, frame: 287 },
  ])('keeps the answer and native frame contract for $viewport/$hasScreenshot', ({ viewport, hasScreenshot, content, frame }) => {
    expect(visionDialogHeight(viewport, hasScreenshot)).toBe(content)
    expect(visionDialogFrameHeight(viewport, hasScreenshot)).toBe(frame)
    expect(visionDialogHeight(viewport, false)).toBe(Math.round(content * (hasScreenshot ? 1.5 : 1)))
  })

  it('retains the existing viewport content metric before mode reduction', () => {
    expect(visionAnswerHeight(720)).toBe(324)
  })
})

