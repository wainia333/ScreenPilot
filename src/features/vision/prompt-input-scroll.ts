export type PromptCaretFrameRequest = (callback: () => void) => number
export type PromptCaretFrameCancel = (handle: number) => void

export function isVisionPromptInput(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement
    && (target.getAttribute('placeholder') === '问点什么...' || target.getAttribute('placeholder') === 'Ask anything...')
}

export function syncVisionPromptCaret(input: HTMLInputElement): void {
  const end = input.value.length
  if (input.selectionStart !== end || input.selectionEnd !== end) return
  input.scrollLeft = input.scrollWidth
}

export function scheduleVisionPromptCaretSync(
  input: HTMLInputElement,
  requestFrame: PromptCaretFrameRequest = (callback) => window.requestAnimationFrame(() => callback()),
  cancelFrame: PromptCaretFrameCancel = (handle) => window.cancelAnimationFrame(handle),
): () => void {
  let firstFrame: number | null = null
  let secondFrame: number | null = null
  let cancelled = false

  const run = () => {
    firstFrame = null
    if (cancelled) return
    syncVisionPromptCaret(input)
    secondFrame = requestFrame(() => {
      secondFrame = null
      if (!cancelled) syncVisionPromptCaret(input)
    })
  }

  firstFrame = requestFrame(run)
  return () => {
    cancelled = true
    if (firstFrame !== null) cancelFrame(firstFrame)
    if (secondFrame !== null) cancelFrame(secondFrame)
    firstFrame = null
    secondFrame = null
  }
}
