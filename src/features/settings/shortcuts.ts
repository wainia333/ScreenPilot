import type { ShortcutSettings, SettingsIssue } from './types'

const modifierOrder = ['Control', 'Alt', 'Shift', 'Super'] as const
type ShortcutModifier = (typeof modifierOrder)[number]

const modifierAliases: Record<string, ShortcutModifier> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  cmd: 'Super',
  command: 'Super',
  meta: 'Super',
  super: 'Super',
  win: 'Super',
  windows: 'Super',
}

const keyAliases: Record<string, string> = {
  ' ': 'Space',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  return: 'Enter',
  enter: 'Enter',
  backspace: 'Backspace',
  insert: 'Insert',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  backquote: 'Backquote',
  '`': 'Backquote',
  backslash: 'Backslash',
  '\\': 'Backslash',
  bracketleft: 'BracketLeft',
  '[': 'BracketLeft',
  bracketright: 'BracketRight',
  ']': 'BracketRight',
  comma: 'Comma',
  ',': 'Comma',
  equal: 'Equal',
  '=': 'Equal',
  '+': 'Equal',
  minus: 'Minus',
  '-': 'Minus',
  '_': 'Minus',
  period: 'Period',
  '.': 'Period',
  '>': 'Period',
  '<': 'Comma',
  quote: 'Quote',
  "'": 'Quote',
  '"': 'Quote',
  semicolon: 'Semicolon',
  ';': 'Semicolon',
  ':': 'Semicolon',
  slash: 'Slash',
  '/': 'Slash',
  '?': 'Slash',
  '|': 'Backslash',
  '~': 'Backquote',
  tab: 'Tab',
}

const modifierSet = new Set<string>(modifierOrder)

function shortcutTokens(value: string): string[] {
  // A pre-contract recorder could persist Shift++ for the plus key. The
  // canonical token is Equal because `+` is the shortcut separator.
  const trimmed = value.trim()
  if (trimmed === '+' || trimmed === '++') return ['+']
  const plusKey = trimmed.endsWith('++')
  const source = plusKey ? trimmed.slice(0, -2) : value
  const tokens = source.split('+')
  if (plusKey) tokens.push('+')
  return tokens
    .map((part) => part.trim().length === 0 && part.length > 0 ? ' ' : part.trim())
    .filter(Boolean)
}

function canonicalKey(token: string): string {
  const lowered = token.toLowerCase()
  const alias = keyAliases[lowered]
  if (alias !== undefined) return alias
  if (/^key[a-z]$/i.test(token)) return token.slice(3).toUpperCase()
  if (/^digit[0-9]$/i.test(token)) return token.slice(5)
  if (/^numpad(?:[0-9]|add|decimal|divide|enter|equal|multiply|subtract)$/i.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1)
  }
  if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(token)) return token.toUpperCase()
  return token.length === 1 ? token.toUpperCase() : token
}

export function normalizeShortcut(value: string): string {
  const raw = shortcutTokens(value)
  const modifiers = new Set<(typeof modifierOrder)[number]>()
  let key = ''
  for (const token of raw) {
    const lowered = token.toLowerCase()
    const modifier = modifierAliases[lowered]
    if (modifier !== undefined) {
      modifiers.add(modifier)
      continue
    }
    key = canonicalKey(token)
  }
  return [...modifierOrder.filter((part) => modifiers.has(part)), key].filter(Boolean).join('+')
}

export function displayShortcut(value: string): string {
  return normalizeShortcut(value)
    .split('+')
    .map((part) => part === 'Control' ? 'Ctrl' : part)
    .join('+')
}

export function isModifierOnlyShortcut(value: string): boolean {
  const normalized = normalizeShortcut(value)
  return normalized.length > 0 && normalized.split('+').every((token) => modifierSet.has(token))
}

export function shortcutIssues(
  shortcuts: ShortcutSettings,
  enabled: Partial<Record<keyof ShortcutSettings, boolean>> = {},
): SettingsIssue[] {
  const entries = Object.entries(shortcuts) as [keyof ShortcutSettings, string][]
  const issues: SettingsIssue[] = []
  const owners = new Map<string, keyof ShortcutSettings>()
  for (const [name, raw] of entries) {
    if (enabled[name] === false) continue
    const normalized = normalizeShortcut(raw)
    if (normalized.length === 0) {
      issues.push({
        path: `shortcuts.${name}`,
        code: 'missing',
        message: 'Shortcut cannot be empty',
      })
      continue
    }
    if (isModifierOnlyShortcut(normalized)) {
      issues.push({
        path: `shortcuts.${name}`,
        code: 'invalid',
        message: 'Shortcut must include a non-modifier key',
      })
      continue
    }
    const existing = owners.get(normalized)
    if (existing !== undefined) {
      issues.push({
        path: `shortcuts.${name}`,
        code: 'conflict',
        message: `Shortcut conflicts with ${existing}`,
      })
      continue
    }
    owners.set(normalized, name)
  }
  return issues
}
