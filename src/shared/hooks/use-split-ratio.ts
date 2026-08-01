import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react'

function initialRatio(key: string, defaultRatio: number): number {
  try {
    const stored = localStorage.getItem(key)
    if (stored === null) return defaultRatio
    const value = Number(stored)
    return Number.isFinite(value) ? Math.min(0.76, Math.max(0.24, value)) : defaultRatio
  } catch {
    return defaultRatio
  }
}

export function useSplitRatio(key: string, defaultRatio = 0.5) {
  const [ratio, setRatio] = useState(() => initialRatio(key, defaultRatio))
  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const container = event.currentTarget.parentElement
      if (container === null) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const move = (moveEvent: PointerEvent) => {
        const bounds = container.getBoundingClientRect()
        const next = Math.min(0.76, Math.max(0.24, (moveEvent.clientY - bounds.top) / bounds.height))
        setRatio(next)
      }
      const finish = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        setRatio((current) => {
          try {
            localStorage.setItem(key, String(current))
          } catch {
            return current
          }
          return current
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish, { once: true })
    },
    [key],
  )
  return { ratio, beginResize }
}
