export type HistoryItem = {
  id: string
  updatedAt: number
}

export type HistorySaveResult<T extends HistoryItem> =
  | { ok: true; history: T[]; persistedHistory: T[] }
  | { ok: false; history: T[]; persistedHistory: T[]; error: unknown }

export function loadHistory<T extends HistoryItem>(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  valid: (value: unknown) => value is T,
): T[] {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(valid).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20)
  } catch {
    return []
  }
}

export function saveHistory<T extends HistoryItem>(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  items: T[],
  persistedItems: T[] = [],
): HistorySaveResult<T> {
  const limited = [...items].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20)
  try {
    storage.setItem(key, JSON.stringify(limited))
  } catch (error) {
    return {
      ok: false,
      history: limited,
      persistedHistory: [...persistedItems],
      error,
    }
  }
  return { ok: true, history: limited, persistedHistory: limited }
}

export function upsertHistory<T extends HistoryItem>(items: T[], next: T): T[] {
  return [next, ...items.filter((item) => item.id !== next.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 20)
}
