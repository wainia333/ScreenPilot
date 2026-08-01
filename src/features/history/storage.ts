export type HistoryItem = {
  id: string
  updatedAt: number
}

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
): T[] {
  const limited = [...items].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20)
  try {
    storage.setItem(key, JSON.stringify(limited))
  } catch {
    return limited
  }
  return limited
}

export function upsertHistory<T extends HistoryItem>(items: T[], next: T): T[] {
  return [next, ...items.filter((item) => item.id !== next.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 20)
}
