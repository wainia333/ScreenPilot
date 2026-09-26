import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadVisionHistory,
  saveVisionHistory,
  VISION_HISTORY_STORAGE_KEY,
  VISION_HISTORY_STORAGE_KEYS_LEGACY,
  type VisionHistoryItem,
} from './history'

const validItem: VisionHistoryItem = {
  id: 'capture-1',
  imagePreview: 'data:image/png;base64,AA==',
  appLabel: 'Synthetic',
  messages: [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
  ],
  capturedFrame: { x: 10, y: 20, width: 300, height: 200, label: 'Synthetic' },
  timestamp: 1_700_000_000_000,
}

describe('Vision history storage', () => {
  beforeEach(() => localStorage.clear())

  it('rejects malformed entries such as [{}] and repairs storage', () => {
    localStorage.setItem(VISION_HISTORY_STORAGE_KEY, '[{}]')
    expect(loadVisionHistory(localStorage)).toEqual({ items: [], rejectedCount: 1 })
    expect(localStorage.getItem(VISION_HISTORY_STORAGE_KEY)).toBe('[]')
  })

  it('keeps valid entries while dropping corrupt siblings', () => {
    localStorage.setItem(VISION_HISTORY_STORAGE_KEY, JSON.stringify([validItem, { id: 'broken' }]))
    const loaded = loadVisionHistory(localStorage)
    expect(loaded.items).toEqual([validItem])
    expect(loaded.rejectedCount).toBe(1)
    expect(JSON.parse(localStorage.getItem(VISION_HISTORY_STORAGE_KEY) ?? '[]')).toEqual([validItem])
  })

  it('repairs invalid JSON in the primary storage key', () => {
    localStorage.setItem(VISION_HISTORY_STORAGE_KEY, '{not-json')
    expect(loadVisionHistory(localStorage)).toEqual({ items: [], rejectedCount: 1 })
    expect(localStorage.getItem(VISION_HISTORY_STORAGE_KEY)).toBe('[]')
  })

  it('repairs invalid JSON migrated from a legacy key', () => {
    const legacyKey = VISION_HISTORY_STORAGE_KEYS_LEGACY[0]
    localStorage.setItem(legacyKey, '{not-json')
    expect(loadVisionHistory(localStorage)).toEqual({ items: [], rejectedCount: 1 })
    expect(localStorage.getItem(VISION_HISTORY_STORAGE_KEY)).toBe('[]')
    expect(localStorage.getItem(legacyKey)).toBeNull()
  })

  it('returns an explicit failure while retaining the last confirmed snapshot', () => {
    const oldHistory = [validItem]
    const nextHistory = [{ ...validItem, id: 'capture-2' }]
    const result = saveVisionHistory(
      { setItem: () => { throw new DOMException('quota') } } as Storage,
      nextHistory,
      oldHistory,
    )
    expect(result.ok).toBe(false)
    expect(result.history).toEqual(nextHistory)
    expect(result.persistedHistory).toEqual(oldHistory)
  })

  it('confirms a new snapshot only after serialization and storage succeed', () => {
    let value = ''
    const nextHistory = [{ ...validItem, id: 'capture-2' }]
    const result = saveVisionHistory({ setItem: (_key, serialized) => { value = serialized } } as Storage, nextHistory)
    expect(result).toEqual({ ok: true, history: nextHistory, persistedHistory: nextHistory })
    expect(JSON.parse(value)).toEqual(nextHistory)
  })
})
