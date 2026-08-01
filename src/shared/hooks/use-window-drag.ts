import { useCallback, type PointerEventHandler } from 'react'
import { useDesktop } from '../../desktop/use-desktop'

const interactiveSelector = [
  'a',
  'button',
  'input',
  'label',
  'select',
  'summary',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function isWindowDragExcluded(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(interactiveSelector) !== null
}

export function useWindowDrag(): PointerEventHandler<HTMLElement> {
  const desktop = useDesktop()
  return useCallback((event) => {
    if (event.button !== 0 || event.defaultPrevented || isWindowDragExcluded(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    void desktop.startDragging().catch((error: unknown) => {
      console.error('Failed to start window dragging', error)
    })
  }, [desktop])
}
