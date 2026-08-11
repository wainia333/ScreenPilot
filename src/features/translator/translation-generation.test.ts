import { afterEach, describe, expect, it, vi } from 'vitest'

describe('translator generation allocator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    sessionStorage.clear()
    localStorage.clear()
  })

  it('stays monotonic across a same-millisecond module rebuild', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const firstModule = await import('./translation-generation')
    const first = firstModule.nextTranslationGeneration()

    vi.resetModules()
    const rebuiltModule = await import('./translation-generation')
    const second = rebuiltModule.nextTranslationGeneration()

    expect(second).toBe(first + 1)
    expect(second).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('does not go backwards when the system clock moves backwards', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const generation = await import('./translation-generation')
    const first = generation.nextTranslationGeneration()
    now.mockReturnValue(1_700_000_000_000)
    expect(generation.nextTranslationGeneration()).toBe(first + 1)
  })
})
