import { describe, expect, it } from 'vitest'
import {
  VisionRequestLifecycle,
  appendVisionError,
  mergeVisionResponse,
} from './request-lifecycle'

describe('Vision request lifecycle', () => {
  it('rejects stale same-image events after Stop and accepts the next request', () => {
    const lifecycle = new VisionRequestLifecycle()
    const first = lifecycle.begin()
    expect(lifecycle.matchesStream('same-image', { imageId: 'same-image', requestId: first })).toBe(true)
    const invalidation = lifecycle.invalidate()
    const second = lifecycle.begin()
    expect(lifecycle.matchesStream('same-image', { imageId: 'same-image', requestId: first })).toBe(false)
    expect(lifecycle.matchesStream('same-image', { imageId: 'same-image', requestId: second })).toBe(true)
    expect(lifecycle.isCurrentInvalidation(invalidation)).toBe(false)
  })

  it('keeps text-only requests isolated when image ids are empty', () => {
    const lifecycle = new VisionRequestLifecycle()
    const first = lifecycle.begin()
    lifecycle.invalidate()
    const second = lifecycle.begin()
    expect(lifecycle.matchesStream('', { imageId: '', requestId: first })).toBe(false)
    expect(lifecycle.matchesStream('', { imageId: '', requestId: second })).toBe(true)
  })

  it('does not finalize after a stale or mismatched result', () => {
    const lifecycle = new VisionRequestLifecycle()
    const first = lifecycle.begin()
    expect(lifecycle.acceptResult(first, 'other')).toBe(false)
    expect(lifecycle.canFinalize(first)).toBe(false)
    const invalidation = lifecycle.invalidate()
    expect(lifecycle.isCurrentInvalidation(invalidation)).toBe(true)
    expect(lifecycle.acceptResult(first, first)).toBe(false)
    expect(lifecycle.canFinalize(first)).toBe(false)
  })

  it('accepts terminal result before finalization and rejects stale errors', () => {
    const lifecycle = new VisionRequestLifecycle()
    const requestId = lifecycle.begin()
    expect(lifecycle.settleError(requestId)).toBe(true)
    expect(lifecycle.canFinalize(requestId)).toBe(true)
    lifecycle.invalidate()
    expect(lifecycle.settleError(requestId)).toBe(false)
  })

  it('uses the matching nonstream response as canonical content exactly once', () => {
    expect(mergeVisionResponse('partial\n\n⚠️ provider failed', 'canonical answer\n\n⚠️ provider failed'))
      .toBe('canonical answer\n\n⚠️ provider failed')
    expect(mergeVisionResponse('canonical answer', 'canonical answer')).toBe('canonical answer')
  })

  it('appends visible errors without replacing partial output or duplicating status', () => {
    const partial = 'partial answer'
    const withError = appendVisionError(partial, 'provider failed')
    expect(withError).toBe('partial answer\n\n⚠️ provider failed')
    expect(appendVisionError(withError, 'provider failed')).toBe(withError)
  })

  it('deduplicates the same terminal error across stream and localized command responses', () => {
    const error = 'KARAKEEP_BUDGET: 检索未完成'
    const streamed = appendVisionError('partial answer', error)
    expect(appendVisionError(streamed, error, '出错了')).toBe(streamed)
    const returned = appendVisionError('partial answer', error, '出错了')
    expect(appendVisionError(returned, error)).toBe(returned)
    expect(returned).toContain('partial answer')
    expect(returned).toContain('⚠️ 出错了:')
  })
})
