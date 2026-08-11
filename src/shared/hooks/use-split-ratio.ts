import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

const MIN_RATIO = 0.24
const MAX_RATIO = 0.76
const KEYBOARD_STEP = 0.04

function clampRatio(value: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value))
}

function initialRatio(key: string, defaultRatio: number): number {
  try {
    const stored = localStorage.getItem(key)
    if (stored === null) return defaultRatio
    const value = Number(stored)
    return Number.isFinite(value) ? clampRatio(value) : defaultRatio
  } catch {
    return defaultRatio
  }
}

export function useSplitRatio(key: string, defaultRatio = 0.5) {
  const [ratio, setRatio] = useState(() => initialRatio(key, defaultRatio))
  const persistRatio = useCallback((value: number) => {
    const next = clampRatio(value)
    setRatio(next)
    try {
      localStorage.setItem(key, String(next))
    } catch {
      // The interaction still works when storage is unavailable.
    }
  }, [key])
  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const container = event.currentTarget.parentElement
      if (container === null) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const move = (moveEvent: PointerEvent) => {
        const bounds = container.getBoundingClientRect()
        const next = clampRatio((moveEvent.clientY - bounds.top) / bounds.height)
        setRatio(next)
      }
      const finish = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        setRatio((current) => {
          try { localStorage.setItem(key, String(current)) } catch { void 0 }
          return current
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish, { once: true })
    },
    [key],
  )
  const resizeByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = ratio - KEYBOARD_STEP
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = ratio + KEYBOARD_STEP
    if (event.key === 'Home') next = MIN_RATIO
    if (event.key === 'End') next = MAX_RATIO
    if (next === null) return
    event.preventDefault()
    persistRatio(next)
  }, [persistRatio, ratio])
  return { ratio, beginResize, resizeByKeyboard }
}
