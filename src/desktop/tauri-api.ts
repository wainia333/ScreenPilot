import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'

export type TauriEvent<T> = { payload: T }

export type TauriApi = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (event: TauriEvent<T>) => void): Promise<() => void>
  resizeCurrentWindow(width: number, height: number): Promise<void>
  startDraggingCurrentWindow(): Promise<void>
}

export const defaultTauriApi: TauriApi = {
  invoke,
  listen,
  resizeCurrentWindow: (width, height) => getCurrentWindow().setSize(new LogicalSize(width, height)),
  startDraggingCurrentWindow: () => getCurrentWindow().startDragging(),
}
