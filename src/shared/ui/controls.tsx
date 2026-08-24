import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export function SettingGroup({ title, titleAction, children }: { title: string; titleAction?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting-group">
      <div className="setting-group__heading">
        <h2>{title}</h2>
        {titleAction}
      </div>
      <div className="setting-group__body">{children}</div>
    </section>
  )
}

export function SettingRow({
  label,
  description,
  nested = false,
  children,
}: {
  label: string
  description?: string
  nested?: boolean
  children: ReactNode
}) {
  return (
    <div className={`setting-row${nested ? ' setting-row--nested' : ''}`}>
      <div className="setting-row__copy">
        <span className="setting-row__label">{label}</span>
        {description === undefined ? null : <span className="setting-row__description">{description}</span>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      className="toggle"
      data-checked={checked}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  label: string
  onChange: (value: T) => void
}) {
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>())
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = options.length - 1
    if (nextIndex === null) return
    const next = options[nextIndex]
    if (next === undefined) return
    event.preventDefault()
    onChange(next.value)
    buttonRefs.current.get(next.value)?.focus()
  }
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.value}
          data-active={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          key={option.value}
          ref={(element) => {
            if (element === null) buttonRefs.current.delete(option.value)
            else buttonRefs.current.set(option.value, element)
          }}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => moveSelection(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function TextField({
  value,
  label,
  placeholder,
  type = 'text',
  disabled = false,
  onChange,
}: {
  value: string
  label: string
  placeholder?: string
  type?: 'text' | 'password' | 'url'
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <input
      className="text-field"
      value={value}
      type={type}
      disabled={disabled}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function SelectField<T extends string>({
  value,
  label,
  options,
  onChange,
}: {
  value: T
  label: string
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <select
      className="select-field"
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option value={option.value} key={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function PromptResetButton({
  value,
  label,
  defaultValue,
  resetLabel = '恢复默认',
  onChange,
}: {
  value: string
  label: string
  defaultValue: string
  resetLabel?: string
  onChange: (value: string) => void
}) {
  return (
    <button
      type="button"
      className="prompt-reset-button"
      aria-label={`${resetLabel}：${label}`}
      disabled={value === defaultValue}
      onClick={() => onChange(defaultValue)}
    >
      {resetLabel}
    </button>
  )
}

export function PromptField({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (value: string) => void
}) {
  return (
    <textarea
      className="prompt-field"
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
