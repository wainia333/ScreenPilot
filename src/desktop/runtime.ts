import { createContext } from 'react'
import type { DesktopPort } from './contract'
import { FakeDesktopPort } from './fake-desktop'
import { TauriDesktopPort } from './tauri-adapter'

const hasTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const defaultDesktopPort: DesktopPort = hasTauriRuntime
  ? new TauriDesktopPort()
  : new FakeDesktopPort()

export const DesktopContext = createContext<DesktopPort>(defaultDesktopPort)
