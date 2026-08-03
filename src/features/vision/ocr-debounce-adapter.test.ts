import { afterEach, describe, expect, it, vi } from 'vitest'
import { installOcrDebounceTimingAdapter } from './ocr-debounce-adapter'

type TimerCallback = (...arguments_: unknown[]) => void

function createTimeoutTarget() {
  const targetSetTimeout = ((handler: TimerCallback, timeout?: number, ...arguments_: unknown[]) => (
    window.setTimeout(handler, timeout, ...arguments_)
  )) as typeof window.setTimeout
  return { setTimeout: targetSetTimeout }
}

describe('OCR debounce timing adapter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('extends only the vendor OCR edit delay and restores the timer', () => {
    vi.useFakeTimers()
    const target = createTimeoutTarget()
    const restore = installOcrDebounceTimingAdapter(target)
    let adaptedFired = false
    let unchangedFired = false
    target.setTimeout(() => { adaptedFired = true }, 900)
    target.setTimeout(() => { unchangedFired = true }, 899)

    vi.advanceTimersByTime(899)
    expect(unchangedFired).toBe(true)
    expect(adaptedFired).toBe(false)
    vi.advanceTimersByTime(101)
    expect(adaptedFired).toBe(true)

    restore()
    let restoredFired = false
    target.setTimeout(() => { restoredFired = true }, 900)
    vi.advanceTimersByTime(899)
    expect(restoredFired).toBe(false)
    vi.advanceTimersByTime(1)
    expect(restoredFired).toBe(true)
  })

  it('does not clobber a newer timer owner during cleanup', () => {
    vi.useFakeTimers()
    const target = createTimeoutTarget()
    const restore = installOcrDebounceTimingAdapter(target)
    const replacement = ((handler: TimerCallback, timeout?: number, ...arguments_: unknown[]) => (
      window.setTimeout(handler, timeout, ...arguments_)
    )) as typeof window.setTimeout
    target.setTimeout = replacement
    restore()
    expect(target.setTimeout === replacement).toBe(true)
  })
})
