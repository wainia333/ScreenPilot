import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleVisionTranslationEdit,
  VISION_TRANSLATE_EDIT_DEBOUNCE_MS,
} from './translation-edit-debounce'

describe('Vision translation edit debounce', () => {
  afterEach(() => vi.useRealTimers())

  it('fires only at the fixed 1500ms boundary', () => {
    vi.useFakeTimers()
    const request = vi.fn()
    scheduleVisionTranslationEdit(request)

    expect(VISION_TRANSLATE_EDIT_DEBOUNCE_MS).toBe(1500)
    vi.advanceTimersByTime(1499)
    expect(request).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(request).toHaveBeenCalledOnce()
  })
})
