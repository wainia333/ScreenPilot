import type { ReactNode } from 'react'

export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setting-group">
      <h2>{title}</h2>
      <div className="setting-group__body">{children}</div>
    </section>
  )
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="setting-row">
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
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.value}
          data-active={value === option.value}
          key={option.value}
          onClick={() => onChange(option.value)}
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
  onChange,
}: {
  value: string
  label: string
  placeholder?: string
  type?: 'text' | 'password' | 'url'
  onChange: (value: string) => void
}) {
  return (
    <input
      className="text-field"
      value={value}
      type={type}
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
