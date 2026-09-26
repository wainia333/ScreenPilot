import { describe, expect, it } from 'vitest'
import { displayShortcut, normalizeShortcut, shortcutIssues } from './shortcuts'

describe('normalizeShortcut', () => {
  it.each([
    [' ctrl + alt + p ', 'Control+Alt+P'],
    ['Shift+Control+F2', 'Control+Shift+F2'],
    ['cmd+option+k', 'Alt+Super+K'],
    ['escape', 'Escape'],
    ['f24', 'F24'],
    ['Control+ ', 'Control+Space'],
    ['Shift++', 'Shift+Equal'],
    ['Shift+,', 'Shift+Comma'],
    ['ArrowUp', 'ArrowUp'],
    ['KeyQ', 'Q'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeShortcut(input)).toBe(expected)
  })
})

describe('shortcutIssues', () => {
  const shortcuts = {
    translator: 'F2',
    vision: 'F2',
    screenshotTranslation: 'Control',
    promptOptimizer: 'F4',
  }

  it('only checks enabled features and catches a conflict after re-enabling one', () => {
    expect(shortcutIssues(shortcuts, {
      translator: true,
      vision: false,
      screenshotTranslation: true,
      promptOptimizer: true,
    })).toContainEqual(expect.objectContaining({ path: 'shortcuts.screenshotTranslation', code: 'invalid' }))
    expect(shortcutIssues(shortcuts, {
      translator: true,
      vision: false,
      screenshotTranslation: false,
      promptOptimizer: true,
    })).toEqual([])
    expect(shortcutIssues(shortcuts, {
      translator: true,
      vision: true,
      screenshotTranslation: false,
      promptOptimizer: true,
    })).toContainEqual(expect.objectContaining({ path: 'shortcuts.vision', code: 'conflict' }))
  })

  it('requires an ordinary key for global shortcuts while allowing AltSnap modifiers', () => {
    expect(shortcutIssues({ ...shortcuts, translator: 'Control+Alt' })).toContainEqual(
      expect.objectContaining({ path: 'shortcuts.translator', code: 'invalid' }),
    )
    expect(normalizeShortcut('Control+Alt')).toBe('Control+Alt')
  })
})

describe('displayShortcut', () => {
  it('uses Ctrl for Control in the settings UI', () => {
    expect(displayShortcut('Control+Alt+P')).toBe('Ctrl+Alt+P')
    expect(displayShortcut('F2')).toBe('F2')
  })
})
