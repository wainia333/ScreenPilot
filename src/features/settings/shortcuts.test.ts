import { describe, expect, it } from 'vitest'
import { displayShortcut, normalizeShortcut } from './shortcuts'

describe('normalizeShortcut', () => {
  it.each([
    [' ctrl + alt + p ', 'Control+Alt+P'],
    ['Shift+Control+F2', 'Control+Shift+F2'],
    ['cmd+option+k', 'Alt+Meta+K'],
    ['escape', 'Escape'],
    ['f24', 'F24'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeShortcut(input)).toBe(expected)
  })
})

describe('displayShortcut', () => {
  it('uses Ctrl for Control in the settings UI', () => {
    expect(displayShortcut('Control+Alt+P')).toBe('Ctrl+Alt+P')
    expect(displayShortcut('F2')).toBe('F2')
  })
})
