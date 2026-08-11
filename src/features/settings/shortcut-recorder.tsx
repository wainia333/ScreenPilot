import { useState, type KeyboardEvent } from 'react'

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
}: {
  value: string
  label: string
  recordingLabel?: string
  onChange: (value: string) => void
}) {
  const [recording, setRecording] = useState(false)
  return (
    <button
      type="button"
      className="shortcut-recorder"
      data-recording={recording}
      aria-pressed={recording}
      aria-label={label}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
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
        const shortcut = shortcutFromEvent(event)
        if (shortcut === null) return
        onChange(shortcut)
        setRecording(false)
      }}
    >
      {recording ? recordingLabel : value}
    </button>
  )
}
