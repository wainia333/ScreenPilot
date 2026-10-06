import type { ReactNode } from 'react'
import './popup-menu.css'

export function PopupMenuItem({ label, shortcut = '', disabled = false, checked, destructive = false, onClick }: {
  label: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean | undefined
  destructive?: boolean
  onClick: () => void
}) {
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled} data-destructive={destructive || undefined} onClick={onClick}>
    <span>{label}</span>
    <span className="sp-popup-menu__trailing">
      {shortcut && <kbd>{shortcut}</kbd>}
      {checked !== undefined && <span className="sp-popup-menu__check" aria-hidden="true">{checked && <svg viewBox="0 0 20 20"><path d="m4 10 4 4 8-8" /></svg>}</span>}
    </span>
  </button>
}

export function PopupMenu({ children, label, className = '', ...props }: { children: ReactNode; label: string } & Omit<React.HTMLAttributes<HTMLDivElement>, 'aria-label'>) {
  return <div {...props} className={`sp-popup-menu ${className}`} role="menu" aria-label={label}>{children}</div>
}
