import { useRef, useState, type KeyboardEvent } from 'react'
import { displayShortcut } from './shortcuts'

function shortcutFromEvent(event: KeyboardEvent<HTMLButtonElement>): string | null {
  const modifiers = [
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    event.metaKey ? 'Super' : null,
  ].filter((value): value is string => value !== null)
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (key === 'Escape' || key === 'Tab') return null
  return [...modifiers, key].join('+')
}

export function ShortcutRecorder({
  value,
  label,
  recordingLabel = '请按快捷键',
  onChange,
  allowModifierOnly = false,
}: {
  value: string
  label: string
  recordingLabel?: string
  onChange: (value: string) => void
  allowModifierOnly?: boolean
}) {
  const [recording, setRecording] = useState(false)
  const modifiers = useRef('')
  return (
    <button
      type="button"
      className="shortcut-recorder"
      data-recording={recording}
      aria-pressed={recording}
      aria-label={label}
      onClick={() => { modifiers.current = ''; setRecording(true) }}
      onBlur={() => setRecording(false)}
      onKeyUp={(event) => {
        if (!recording || !allowModifierOnly || !modifiers.current) return
        if (!['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
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
        if (allowModifierOnly && ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
          modifiers.current = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean).join('+')
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
