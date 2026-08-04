import { describe, expect, it } from 'vitest'
import {
  isVisionPromptInput,
  scheduleVisionPromptCaretSync,
  syncVisionPromptCaret,
} from './prompt-input-scroll'

function createInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.value = value
  Object.defineProperty(input, 'scrollWidth', { configurable: true, value: 800 })
  return input
}

describe('Vision prompt caret scrolling', () => {
  it.each(['问点什么...', 'Ask anything...'])('recognizes the %s prompt input', (placeholder) => {
    const input = document.createElement('input')
    input.setAttribute('placeholder', placeholder)
    expect(isVisionPromptInput(input)).toBe(true)
  })

  it('syncs an end caret to the input scroll edge', () => {
    const input = createInput('这是一段很长的中文输入。')
    input.setSelectionRange(input.value.length, input.value.length)
    syncVisionPromptCaret(input)
    expect(input.scrollLeft).toBe(800)
  })

  it('does not move a caret that is editing in the middle', () => {
    const input = createInput('Edit the middle of this long prompt.')
    input.scrollLeft = 24
    input.setSelectionRange(5, 5)
    syncVisionPromptCaret(input)
    expect(input.scrollLeft).toBe(24)
  })

  it('runs a second frame for late layout updates and can be cancelled', () => {
    const input = createInput('This prompt may resize after input.')
    input.setSelectionRange(input.value.length, input.value.length)
    const callbacks: (((() => void) | null))[] = []
    const requestFrame = (callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length - 1
    }
    const cancelFrame = (handle: number) => { callbacks[handle] = null }
    const cancel = scheduleVisionPromptCaretSync(input, requestFrame, cancelFrame)
    expect(callbacks).toHaveLength(1)
    callbacks[0]?.()
    expect(input.scrollLeft).toBe(800)
    expect(callbacks).toHaveLength(2)
    input.scrollLeft = 16
    callbacks[1]?.()
    expect(input.scrollLeft).toBe(800)
    const pendingCancel = scheduleVisionPromptCaretSync(input, requestFrame, cancelFrame)
    const pendingFrame = callbacks.length - 1
    pendingCancel()
    expect(callbacks[pendingFrame]).toBeNull()
    cancel()
  })
})
