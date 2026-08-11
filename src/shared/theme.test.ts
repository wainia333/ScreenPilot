import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeDocumentThemeSync, syncDocumentTheme } from './theme'

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  let addCalls = 0
  const media = {
    get matches() { return matches },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      addCalls += 1
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', () => media)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media })
  return {
    setMatches(next: boolean) {
      matches = next
      const event = { matches: next, media: media.media } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
    get addCalls() { return addCalls },
  }
}

describe('syncDocumentTheme', () => {
  afterEach(() => {
    disposeDocumentThemeSync()
    vi.unstubAllGlobals()
  })

  it('synchronizes data-theme, the vendor dark class and color-scheme', () => {
    const media = installMatchMedia(false)
    expect(syncDocumentTheme('dark')).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    expect(syncDocumentTheme('light')).toBe('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')

    syncDocumentTheme('system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'system')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')

    media.setMatches(true)
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    syncDocumentTheme('light')
    media.setMatches(false)
    media.setMatches(true)
    expect(document.documentElement).not.toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(media.addCalls).toBe(1)
  })
})
