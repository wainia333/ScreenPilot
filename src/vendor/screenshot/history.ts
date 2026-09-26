import type { ExplainMessage } from './api/tauri'

export type VisionCapturedFrame = {
  x: number
  y: number
  width: number
  height: number
  label: string
}

export type VisionHistoryItem = {
  id: string
  imagePreview: string
  appLabel: string
  messages: ExplainMessage[]
  capturedFrame: VisionCapturedFrame | null
  timestamp: number
  textOnly?: boolean
}

export type VisionHistoryLoadResult = {
  items: VisionHistoryItem[]
  rejectedCount: number
}

export type VisionHistorySaveResult =
  | { ok: true; history: VisionHistoryItem[]; persistedHistory: VisionHistoryItem[] }
  | { ok: false; history: VisionHistoryItem[]; persistedHistory: VisionHistoryItem[]; error: unknown }

export const VISION_HISTORY_STORAGE_KEY = 'kivio:vision-history:v1'
export const VISION_HISTORY_REPAIR_NOTICE_KEY = 'kivio:vision-history-repair-notice:v1'
export const VISION_HISTORY_STORAGE_KEYS_LEGACY = [
  'kivio:lens-history:v1',
  'keylingo:lens-history:v1',
  'keylingo:vision-history:v1',
] as const
export const VISION_HISTORY_MAX = 20

function readRepairNotice(storage: Storage): number {
  try {
    const count = Number(storage.getItem(VISION_HISTORY_REPAIR_NOTICE_KEY))
    return Number.isSafeInteger(count) && count > 0 ? count : 0
  } catch {
    return 0
  }
}

function writeRepairNotice(storage: Storage, rejectedCount: number) {
  if (rejectedCount <= 0) return
  try {
    storage.setItem(VISION_HISTORY_REPAIR_NOTICE_KEY, String(Math.max(readRepairNotice(storage), rejectedCount)))
  } catch {
    // The repaired history is still safe to use when the notice cannot persist.
  }
}

function repairStoredHistory(storage: Storage, legacyKey: string | null, serialized = '[]') {
  try {
    storage.setItem(VISION_HISTORY_STORAGE_KEY, serialized)
  } catch {
    // Storage can be unavailable (for example in a restricted webview). Loading
    // history must remain non-fatal even when the best-effort repair cannot persist.
  }
  if (legacyKey !== null) {
    try {
      storage.removeItem(legacyKey)
    } catch {
      // See above: a failed cleanup must not prevent the app from opening.
    }
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validFrame(value: unknown): value is VisionCapturedFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Partial<VisionCapturedFrame>
  return finiteNumber(frame.x)
    && finiteNumber(frame.y)
    && finiteNumber(frame.width)
    && frame.width > 0
    && finiteNumber(frame.height)
    && frame.height > 0
    && typeof frame.label === 'string'
}

function validMessage(value: unknown): value is ExplainMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<ExplainMessage>
  return (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && (message.reasoning === undefined || typeof message.reasoning === 'string')
    && (message.imagePreview === undefined || typeof message.imagePreview === 'string')
}

export function isVisionHistoryItem(value: unknown): value is VisionHistoryItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<VisionHistoryItem>
  return typeof item.id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(item.id)
    && typeof item.imagePreview === 'string'
    && typeof item.appLabel === 'string'
    && Array.isArray(item.messages)
    && item.messages.length > 0
    && item.messages.every(validMessage)
    && (item.capturedFrame === null || validFrame(item.capturedFrame))
    && finiteNumber(item.timestamp)
    && item.timestamp > 0
    && (item.textOnly === undefined || typeof item.textOnly === 'boolean')
}

export function loadVisionHistory(storage: Storage): VisionHistoryLoadResult {
  let raw: string | null
  let legacyKey: string | null = null
  try {
    raw = storage.getItem(VISION_HISTORY_STORAGE_KEY)
    if (!raw) {
      for (const candidate of VISION_HISTORY_STORAGE_KEYS_LEGACY) {
        const legacy = storage.getItem(candidate)
        if (!legacy) continue
        raw = legacy
        legacyKey = candidate
        break
      }
    }
  } catch {
    return { items: [], rejectedCount: 1 }
  }

  if (!raw) return { items: [], rejectedCount: readRepairNotice(storage) }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    writeRepairNotice(storage, 1)
    repairStoredHistory(storage, legacyKey)
    return { items: [], rejectedCount: 1 }
  }

  if (!Array.isArray(parsed)) {
    writeRepairNotice(storage, 1)
    repairStoredHistory(storage, legacyKey)
    return { items: [], rejectedCount: 1 }
  }

  const validItems = parsed.filter(isVisionHistoryItem)
  const items = validItems.slice(0, VISION_HISTORY_MAX)
  const rejectedCount = parsed.length - validItems.length
  writeRepairNotice(storage, rejectedCount)
  if (legacyKey !== null || rejectedCount > 0 || validItems.length > VISION_HISTORY_MAX) {
    repairStoredHistory(storage, legacyKey, JSON.stringify(items))
  }
  return { items, rejectedCount: Math.max(rejectedCount, readRepairNotice(storage)) }
}

export function saveVisionHistory(
  storage: Storage,
  history: VisionHistoryItem[],
  persistedHistory: VisionHistoryItem[] = [],
): VisionHistorySaveResult {
  const limited = history.slice(0, VISION_HISTORY_MAX)
  try {
    storage.setItem(VISION_HISTORY_STORAGE_KEY, JSON.stringify(limited))
    return { ok: true, history: limited, persistedHistory: limited }
  } catch (error) {
    return { ok: false, history: limited, persistedHistory: [...persistedHistory], error }
  }
}
