import type { ShortcutSettings, SettingsIssue } from './types'

const modifierOrder = ['Control', 'Alt', 'Shift', 'Meta'] as const

const modifierAliases: Record<string, (typeof modifierOrder)[number]> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  windows: 'Meta',
}

const keyAliases: Record<string, string> = {
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  return: 'Enter',
  enter: 'Enter',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

export function normalizeShortcut(value: string): string {
  const raw = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const modifiers = new Set<(typeof modifierOrder)[number]>()
  let key = ''
  for (const token of raw) {
    const lowered = token.toLowerCase()
    const modifier = modifierAliases[lowered]
    if (modifier !== undefined) {
      modifiers.add(modifier)
      continue
    }
    const alias = keyAliases[lowered]
    if (alias !== undefined) {
      key = alias
      continue
    }
    if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(token)) {
      key = token.toUpperCase()
      continue
    }
    key = token.length === 1 ? token.toUpperCase() : token
  }
  return [...modifierOrder.filter((part) => modifiers.has(part)), key].filter(Boolean).join('+')
}

export function shortcutIssues(shortcuts: ShortcutSettings): SettingsIssue[] {
  const entries = Object.entries(shortcuts) as [keyof ShortcutSettings, string][]
  const issues: SettingsIssue[] = []
  const owners = new Map<string, keyof ShortcutSettings>()
  for (const [name, raw] of entries) {
    const normalized = normalizeShortcut(raw)
    if (normalized.length === 0) {
      issues.push({
        path: `shortcuts.${name}`,
        code: 'missing',
        message: 'Shortcut cannot be empty',
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

