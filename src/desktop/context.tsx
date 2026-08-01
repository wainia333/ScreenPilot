import type { ReactNode } from 'react'
import type { DesktopPort } from './contract'
import { defaultDesktopPort, DesktopContext } from './runtime'

export function DesktopProvider({ port = defaultDesktopPort, children }: { port?: DesktopPort; children: ReactNode }) {
  return <DesktopContext.Provider value={port}>{children}</DesktopContext.Provider>
}
