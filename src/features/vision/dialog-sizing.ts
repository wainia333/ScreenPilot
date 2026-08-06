const ANSWER_MIN_HEIGHT = 220
const ANSWER_MAX_HEIGHT = 480
const ANSWER_VIEWPORT_RATIO = 0.45
const SCREENSHOT_DIALOG_RATIO = 2 / 3
const TEXT_ONLY_DIALOG_RATIO = 3 / 2
const READY_BAR_HEIGHT = 56
const FLOATING_GAP = 8
const FRAME_COMPENSATION = 2
// The native transparent Vision surface needs a real client-side margin so
// the original card ring/shadow can paint outside the card without being
// clipped by the HWND bounds.
export const VISION_FLOATING_PADDING = 8

export function visionAnswerHeight(viewportHeight: number): number {
  return Math.round(Math.max(
    ANSWER_MIN_HEIGHT,
    Math.min(ANSWER_MAX_HEIGHT, viewportHeight * ANSWER_VIEWPORT_RATIO),
  ))
}

export function visionDialogHeight(viewportHeight: number, hasScreenshot: boolean): number {
  const currentHeight = Math.round(visionAnswerHeight(viewportHeight) * SCREENSHOT_DIALOG_RATIO)
  return Math.round(currentHeight * (hasScreenshot ? 1 : TEXT_ONLY_DIALOG_RATIO))
}

export function visionDialogFrameHeight(viewportHeight: number, hasScreenshot: boolean): number {
  return READY_BAR_HEIGHT
    + FLOATING_GAP
    + visionDialogHeight(viewportHeight, hasScreenshot)
    + FRAME_COMPENSATION
    + VISION_FLOATING_PADDING * 2
}
