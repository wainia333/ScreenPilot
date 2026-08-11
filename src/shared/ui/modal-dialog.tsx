import { createPortal } from 'react-dom'
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => (
    element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true'
  ))
}

export function ModalDialog({
  titleId,
  descriptionId,
  backdropClassName = '',
  dialogClassName = '',
  initialFocusRef,
  dismissible = true,
  onDismiss,
  children,
}: {
  titleId: string
  descriptionId?: string
  backdropClassName?: string
  dialogClassName?: string
  initialFocusRef?: RefObject<HTMLElement>
  dismissible?: boolean
  onDismiss: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onDismissRef = useRef(onDismiss)
  const dismissibleRef = useRef(dismissible)

  useEffect(() => {
    onDismissRef.current = onDismiss
    dismissibleRef.current = dismissible
  }, [dismissible, onDismiss])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const appRoot = document.getElementById('root')
    const rootWasInert = appRoot?.hasAttribute('inert') ?? false
    const rootAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null
    if (appRoot !== null) {
      appRoot.setAttribute('inert', '')
      appRoot.setAttribute('aria-hidden', 'true')
    }

    let active = true
    queueMicrotask(() => {
      if (!active) return
      const initial = initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog
      initial.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        if (dismissibleRef.current) onDismissRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      const current = document.activeElement
      if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      active = false
      document.removeEventListener('keydown', onKeyDown, true)
      if (appRoot !== null) {
        if (!rootWasInert) appRoot.removeAttribute('inert')
        if (rootAriaHidden === null) appRoot.removeAttribute('aria-hidden')
        else appRoot.setAttribute('aria-hidden', rootAriaHidden)
      }
      queueMicrotask(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus()
      })
    }
  }, [initialFocusRef])

  return createPortal(
    <div className={`dialog-backdrop ${backdropClassName}`.trim()} role="presentation">
      <div
        ref={dialogRef}
        className={`decision-dialog ${dialogClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
