import { useEffect } from 'react'
import { useDesktop } from '../desktop/use-desktop'

function externalAnchor(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return null
  const target = event.target
  if (!(target instanceof Element)) return null
  const anchor = target.closest('a[href]')
  return anchor instanceof HTMLAnchorElement ? anchor : null
}

export function ExternalLinkBridge() {
  const desktop = useDesktop()
  useEffect(() => {
    const open = (event: MouseEvent) => {
      const anchor = externalAnchor(event)
      const url = anchor?.getAttribute('href')?.trim()
      if (!url) return
      event.preventDefault()
      event.stopPropagation()
      void desktop.openExternal(url).catch((error: unknown) => {
        console.error('Failed to open external link', error)
      })
    }
    document.addEventListener('click', open, true)
    document.addEventListener('auxclick', open, true)
    return () => {
      document.removeEventListener('click', open, true)
      document.removeEventListener('auxclick', open, true)
    }
  }, [desktop])
  return null
}
