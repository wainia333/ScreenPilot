import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installSafeFloatingDrag } from './safe-floating-drag'

describe('safe floating drag', () => {
  it('invokes the safe command once and restores the original API', async () => {
    const originalStartDragging = vi.fn(() => Promise.resolve())
    const api = { startDragging: originalStartDragging }
    const invokeStart = vi.fn(() => Promise.resolve())
    const dispose = installSafeFloatingDrag(api, invokeStart)

    await act(async () => { await api.startDragging() })
    expect(invokeStart).toHaveBeenCalledWith('vision_start_safe_drag', {})
    expect(invokeStart).toHaveBeenCalledTimes(1)
    expect(api.startDragging).not.toBe(originalStartDragging)

    dispose()
    expect(api.startDragging).toBe(originalStartDragging)
  })

  it('continues after a rejected command and supports repeated drags', async () => {
    const api = { startDragging: vi.fn(() => Promise.resolve()) }
    const invokeStart = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic drag failure'))
      .mockResolvedValue(undefined)
    const dispose = installSafeFloatingDrag(api, invokeStart)

    await expect(api.startDragging()).rejects.toThrow('synthetic drag failure')
    await api.startDragging()
    await api.startDragging()

    expect(invokeStart).toHaveBeenCalledTimes(3)
    expect(invokeStart).toHaveBeenNthCalledWith(3, 'vision_start_safe_drag', {})
    dispose()
  })

  it('restores stacked installations in reverse order', async () => {
    const originalStartDragging = vi.fn(() => Promise.resolve())
    const api = { startDragging: originalStartDragging }
    const firstInvoke = vi.fn(() => Promise.resolve())
    const secondInvoke = vi.fn(() => Promise.resolve())
    const disposeFirst = installSafeFloatingDrag(api, firstInvoke)
    const firstSafeStart = api.startDragging
    const disposeSecond = installSafeFloatingDrag(api, secondInvoke)

    await api.startDragging()
    expect(secondInvoke).toHaveBeenCalledTimes(1)
    expect(firstInvoke).not.toHaveBeenCalled()

    disposeSecond()
    expect(api.startDragging).toBe(firstSafeStart)
    await api.startDragging()
    expect(firstInvoke).toHaveBeenCalledTimes(1)

    disposeFirst()
    expect(api.startDragging).toBe(originalStartDragging)
  })
})
