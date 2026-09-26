import { createContext } from 'react'
import type { DesktopPort } from './contract'
import { BrowserPreviewDesktopPort } from './fake-desktop'
import { TauriDesktopPort } from './tauri-adapter'

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const hasTauriRuntime = isTauriRuntime()

export const defaultDesktopPort: DesktopPort = hasTauriRuntime
  ? new TauriDesktopPort()
  : new BrowserPreviewDesktopPort()

export const DesktopContext = createContext<DesktopPort>(defaultDesktopPort)
