import { afterEach, describe, expect, it, vi } from 'vitest'

describe('optimizer generation allocator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    sessionStorage.clear()
    localStorage.clear()
  })

  it('stays monotonic across a same-millisecond page rebuild', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const firstModule = await import('./optimizer-generation')
    const first = firstModule.nextOptimizerGeneration()

    vi.resetModules()
    const rebuiltModule = await import('./optimizer-generation')
    const second = rebuiltModule.nextOptimizerGeneration()

    expect(second).toBe(first + 1)
    expect(second).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('does not go backwards when the system clock moves backwards', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const generation = await import('./optimizer-generation')
    const first = generation.nextOptimizerGeneration()
    now.mockReturnValue(1_700_000_000_000)
    expect(generation.nextOptimizerGeneration()).toBe(first + 1)
  })
})
