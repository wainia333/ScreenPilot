import { useId, useRef, type ReactNode, type KeyboardEvent } from 'react'
import './settings-tabs.css'

export function SettingsTabs<T extends string>({ value, options, label, onChange, panelId }: {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  label: string
  onChange: (value: T) => void
  panelId: string
}) {
  const id = useId()
  const buttons = useRef(new Map<T, HTMLButtonElement>())
  const move = (event: KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % options.length
      : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
    const option = next === null ? undefined : options[next]
    if (!option) return
    event.preventDefault()
    onChange(option.value)
    buttons.current.get(option.value)?.focus()
  }
  return <div className="settings-tabs" role="tablist" aria-label={label}>
    {options.map((option, index) => <button
      key={option.value} type="button" role="tab" id={`${id}-${option.value}`}
      aria-selected={value === option.value} aria-controls={panelId}
      tabIndex={value === option.value ? 0 : -1} data-active={value === option.value}
      ref={(node) => { if (node) buttons.current.set(option.value, node); else buttons.current.delete(option.value) }}
      onClick={() => onChange(option.value)} onKeyDown={(event) => move(event, index)}
    >{option.icon}<span>{option.label}</span></button>)}
  </div>
}
