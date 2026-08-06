import { describe, expect, it } from 'vitest'
import {
  shouldReactOwnVisionFloatingResize,
  shouldGrowOcrFloatingWindow,
  shouldRunVisionLandingJelly,
  shouldPromoteVisionBarLayer,
  visionAnswerHeight,
  visionDialogFrameHeight,
  visionDialogHeight,
} from './dialog-sizing'

describe('Vision dialog sizing', () => {
  it.each([
    { viewport: 720, hasScreenshot: true, content: 216, frame: 298 },
    { viewport: 720, hasScreenshot: false, content: 324, frame: 406 },
    { viewport: 400, hasScreenshot: true, content: 147, frame: 229 },
    { viewport: 400, hasScreenshot: false, content: 221, frame: 303 },
  ])('keeps the answer and native frame contract for $viewport/$hasScreenshot', ({ viewport, hasScreenshot, content, frame }) => {
    expect(visionDialogHeight(viewport, hasScreenshot)).toBe(content)
    expect(visionDialogFrameHeight(viewport, hasScreenshot)).toBe(frame)
    expect(visionDialogHeight(viewport, false)).toBe(Math.round(content * (hasScreenshot ? 1.5 : 1)))
  })

  it('retains the existing viewport content metric before mode reduction', () => {
    expect(visionAnswerHeight(720)).toBe(324)
  })

  it('keeps a settled card on the main WebView surface', () => {
    expect(shouldPromoteVisionBarLayer(false, false, true, false, 0, 0)).toBe(false)
  })

  it('keeps the landing spring on both Vision and OCR surfaces', () => {
    expect(shouldRunVisionLandingJelly()).toBe(true)
  })

  it('keeps one native-height owner for the OCR floating window', () => {
    expect(shouldReactOwnVisionFloatingResize('chat')).toBe(true)
    expect(shouldReactOwnVisionFloatingResize('translate')).toBe(false)
  })

  it('waits for native OCR flight to settle and only grows monotonically', () => {
    expect(shouldGrowOcrFloatingWindow(true, 400, 224)).toBe(false)
    expect(shouldGrowOcrFloatingWindow(false, 400, 224)).toBe(true)
    expect(shouldGrowOcrFloatingWindow(false, 400, 224, 400)).toBe(false)
    expect(shouldGrowOcrFloatingWindow(false, 400, 224, 320)).toBe(true)
    expect(shouldGrowOcrFloatingWindow(false, 224, 224)).toBe(false)
  })

  it.each([
    [true, false, true, false, 0, 0],
    [false, true, true, false, 0, 0],
    [false, false, false, false, 0, 0],
    [false, false, true, true, 0, 0],
    [false, false, true, false, 1, 0],
    [false, false, true, false, 0, -1],
  ] as const)(
    'promotes the card only while motion is active',
    (inFlight, jellyActive, introVisible, selectBarHidden, offsetX, offsetY) => {
      expect(shouldPromoteVisionBarLayer(
        inFlight,
        jellyActive,
        introVisible,
        selectBarHidden,
        offsetX,
        offsetY,
      )).toBe(true)
    },
  )
})
