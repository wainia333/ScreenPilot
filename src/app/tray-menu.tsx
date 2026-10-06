import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { PopupMenu, PopupMenuItem } from '../shared/ui/popup-menu'
import { popupMenuHeight, POPUP_MENU_WIDTH, POPUP_MENU_SHADOW } from '../shared/ui/popup-menu-layout'
import './tray-menu.css'

export type TrayMenuModel = {
  generation: number
  items: { id: string; label: string; shortcut: string; enabled: boolean; checked: boolean | null; separator: boolean }[]
  scale: number
  accent: string
}

export function TrayMenu({ model, onAction, onDismiss, onReady }: {
  model: TrayMenuModel
  onAction: (id: string) => void
  onDismiss: () => void
  onReady?: ((width: number, height: number) => void) | undefined
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const actions = model.items.filter(item => !item.separator).length
  const height = popupMenuHeight(actions, model.items.length - actions)
  useLayoutEffect(() => {
    const menu = menuRef.current
    // Opening with the mouse must not select/highlight the first menu item.
    menu?.focus({ preventScroll: true })
    // Wait for a painted frame before revealing the native popup. No fade.
    const frame = requestAnimationFrame(() => {
      const box = menu?.querySelector<HTMLElement>('[role="menu"]')?.getBoundingClientRect()
      const gutter = 2 * POPUP_MENU_SHADOW * model.scale
      onReady?.((box?.width ?? POPUP_MENU_WIDTH * model.scale) + gutter, (box?.height ?? height * model.scale) + gutter)
    })
    return () => cancelAnimationFrame(frame)
  }, [model.generation, model.scale, height, onReady])
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onDismiss(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:enabled') ?? [])]
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
  }
  return <div className="sp-tray-menu-surface" onContextMenu={e => e.preventDefault()} onKeyDown={keyboard} onPointerDown={e => { if (e.target === e.currentTarget) onDismiss() }}>
    <div ref={menuRef} tabIndex={-1}>
      <PopupMenu label="ScreenPilot" style={{ left: POPUP_MENU_SHADOW * model.scale, top: POPUP_MENU_SHADOW * model.scale, transform: `scale(${model.scale})`, '--sp-menu-accent': model.accent } as CSSProperties}>
        {model.items.map((item, index) => item.separator ? <div key={`separator-${index}`} role="separator" /> : <PopupMenuItem key={item.id} label={item.label} shortcut={item.shortcut} disabled={!item.enabled} checked={item.checked ?? undefined} destructive={item.id === 'quit'} onClick={() => onAction(item.id)} />)}
      </PopupMenu>
    </div>
  </div>
}

export function TrayMenuRoot() {
  const [model, setModel] = useState<TrayMenuModel | null>(null)
  useEffect(() => {
    let disposed = false, stop: (() => void) | undefined
    const update = (next: TrayMenuModel | null) => {
      if (!disposed && next) setModel(current => current && current.generation > next.generation ? current : next)
    }
    void listen<TrayMenuModel>('screenpilot:tray-menu', event => update(event.payload)).then(async unlisten => {
      if (disposed) { unlisten(); return }
      stop = unlisten
      update(await invoke<TrayMenuModel | null>('tray_menu_snapshot'))
    }).catch((error: unknown) => { console.error('Tray menu unavailable', error) })
    return () => { disposed = true; stop?.() }
  }, [])
  if (!model) return <div className="sp-tray-menu-surface" />
  return <TrayMenu model={model}
    onReady={(width, height) => { void invoke('tray_menu_ready', { generation: model.generation, width, height }).catch((error: unknown) => { console.error('Tray menu unavailable', error) }) }}
    onAction={action => { void invoke('tray_menu_action', { generation: model.generation, action }).catch((error: unknown) => { console.error('Tray action failed', error) }) }}
    onDismiss={() => { void invoke('tray_menu_dismiss', { generation: model.generation }).catch((error: unknown) => { console.error('Tray dismissal failed', error) }) }}
  />
}
