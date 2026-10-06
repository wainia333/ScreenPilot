import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { CaptureSnapshot, Rect } from './model'
export type CaptureReply = { cancelled?: boolean; path?: string }
export type CapturePayload = { image?: string; pinImage?: string; rect?: Rect; value?: unknown; preferences?: { options: CaptureSnapshot['options']; tools: CaptureSnapshot['tools'] } }
export const captureBridge = {
  snapshot: () => invoke<CaptureSnapshot>('capture_snapshot'),
  ready: async (id: string) => { await invoke('capture_ready', { id }) },
  action: <T = CaptureReply>(id: string, action: string, payload: CapturePayload = {}) => invoke<T>('capture_action', { request: { id, action, ...payload } }),
  frame: (id: string, index: number, showCursor = true) => invoke<ArrayBuffer>('capture_frame', { id, index, showCursor }),
  export: (id: string, options: { format: string; start: number; end: number; speed: number; width: number; height: number; showCursor?: boolean; copy?: boolean }) => invoke<CaptureReply>('capture_export', { request: { id, ...options } }),
  cancelExport: async (id: string) => { await invoke('capture_export_cancel', { id }) },
  session: (callback: () => void) => listen('capture:session', callback),
}
export type CaptureBridge = typeof captureBridge
