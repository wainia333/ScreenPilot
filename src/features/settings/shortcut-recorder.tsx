import { useRef, useState, type KeyboardEvent } from 'react'
import { displayShortcut, normalizeShortcut } from './shortcuts'

const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta'])

const codeAliases: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Backquote: 'Backquote',
  Backslash: 'Backslash',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Comma: 'Comma',
  Equal: 'Equal',
  Minus: 'Minus',
  Period: 'Period',
  Quote: 'Quote',
  Semicolon: 'Semicolon',
  Slash: 'Slash',
  Tab: 'Tab',
}

const keyAliases: Record<string, string> = {
  ' ': 'Space',
  '+': 'Equal',
  '=': 'Equal',
  '-': 'Minus',
  '_': 'Minus',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  '/': 'Slash',
  '?': 'Slash',
  '`': 'Backquote',
  '~': 'Backquote',
  '\\': 'Backslash',
  '|': 'Backslash',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
}

function eventKey(event: KeyboardEvent<HTMLButtonElement>): string | null {
  const code = event.code
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1\d|2[0-4])$/u.test(code)) return code
  const codeAlias = codeAliases[code]
  if (codeAlias !== undefined) return codeAlias
  const keyAlias = keyAliases[event.key]
  if (keyAlias !== undefined) return keyAlias
  return event.key.length === 1 ? event.key.toUpperCase() : event.key
}

function shortcutFromEvent(event: KeyboardEvent<HTMLButtonElement>): string | null {
  const modifiers = [
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    event.metaKey ? 'Super' : null,
  ].filter((value): value is string => value !== null)
  if (modifierKeys.has(event.key)) return null
  const key = eventKey(event)
  if (key === null) return null
  if (key === 'Escape' || key === 'Tab') return null
  return normalizeShortcut([...modifiers, key].join('+'))
}

export function ShortcutRecorder({
  value,
  label,
  recordingLabel = '请按快捷键',
  onChange,
  allowModifierOnly = false,
  issuePath,
}: {
  value: string
  label: string
  recordingLabel?: string
  onChange: (value: string) => void
  allowModifierOnly?: boolean
  issuePath?: string
}) {
  const [recording, setRecording] = useState(false)
  const modifiers = useRef('')
  return (
    <button
      type="button"
      className="shortcut-recorder"
      data-recording={recording}
      data-settings-issue-path={issuePath}
      aria-pressed={recording}
      aria-label={label}
      onClick={() => { modifiers.current = ''; setRecording(true) }}
      onBlur={() => setRecording(false)}
      onKeyUp={(event) => {
        if (!recording || !allowModifierOnly || !modifiers.current) return
        if (!modifierKeys.has(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        onChange(modifiers.current)
        setRecording(false)
      }}
      onKeyDown={(event) => {
        if (!recording) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setRecording(false)
          return
        }
        if (event.key === 'Tab') {
          setRecording(false)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (allowModifierOnly && modifierKeys.has(event.key)) {
          modifiers.current = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean).join('+')
          return
        }
        const shortcut = shortcutFromEvent(event)
        if (shortcut === null) return
        onChange(shortcut)
        setRecording(false)
      }}
    >
      {recording ? recordingLabel : displayShortcut(value)}
    </button>
  )
}
