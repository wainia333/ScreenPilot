import { useContext } from 'react'
import type { DesktopPort } from './contract'
import { DesktopContext } from './runtime'

export function useDesktop(): DesktopPort {
  return useContext(DesktopContext)
}
