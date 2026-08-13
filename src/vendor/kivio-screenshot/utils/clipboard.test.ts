import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from './clipboard'

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('falls back after clipboard rejection and cleans up when legacy copy throws', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('synthetic clipboard denial')) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('synthetic legacy copy failure')
      }),
    })

    await expect(copyToClipboard('copy me')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('uses and cleans up the legacy path when the modern clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => true),
    })

    await expect(copyToClipboard('legacy copy')).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
