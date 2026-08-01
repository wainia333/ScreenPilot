import { describe, expect, it } from 'vitest'
import { loadHistory, saveHistory, upsertHistory, type HistoryItem } from './storage'

type Item = HistoryItem & { text: string }

const valid = (value: unknown): value is Item => {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<Item>
  return typeof item.id === 'string' && typeof item.updatedAt === 'number' && typeof item.text === 'string'
}

describe('history storage', () => {
  it('recovers from corrupted data and quota failures', () => {
    expect(loadHistory({ getItem: () => null }, 'test', valid)).toEqual([])
    expect(loadHistory({ getItem: () => '{"item":true}' }, 'test', valid)).toEqual([])
    expect(loadHistory({ getItem: () => '{bad' }, 'test', valid)).toEqual([])
    const item = { id: 'one', updatedAt: 1, text: 'safe' }
    expect(
      saveHistory(
        { setItem: () => { throw new DOMException('quota') } },
        'test',
        [item],
      ),
    ).toEqual([item])
  })

  it('persists sorted valid history when storage is available', () => {
    let saved = ''
    const items = [
      { id: 'old', updatedAt: 1, text: 'old' },
      { id: 'new', updatedAt: 2, text: 'new' },
    ]
    expect(saveHistory({ setItem: (_key, value) => { saved = value } }, 'test', items)[0]?.id).toBe('new')
    expect(JSON.parse(saved)).toEqual([items[1], items[0]])
  })

  it('updates one round and limits newest-first history to twenty', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: String(index),
      updatedAt: index,
      text: String(index),
    }))
    const limited = upsertHistory(items, { id: '20', updatedAt: 30, text: 'updated' })
    expect(limited).toHaveLength(20)
    expect(limited[0]).toEqual({ id: '20', updatedAt: 30, text: 'updated' })
    expect(limited.filter((item) => item.id === '20')).toHaveLength(1)
  })
})
