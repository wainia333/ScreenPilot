import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TrayMenu, type TrayMenuModel } from './tray-menu'

afterEach(cleanup)
const model = (visible: boolean, enabled = true): TrayMenuModel => ({ generation: 1, scale: 1, accent: '#3388ff', items: [
  { id: 'capture', label: '截图 / 录制 / 扫码', shortcut: 'Ctrl + Alt + S', checked: null, enabled: true, separator: false },
  { id: 'pins', label: '显示 / 隐藏钉图', shortcut: '', checked: visible, enabled, separator: false },
  { id: '', label: '', shortcut: '', checked: null, enabled: false, separator: true },
  { id: 'quit', label: '退出', shortcut: '', checked: null, enabled: true, separator: false },
] })

it('shows the right-side check only for visible pins and disables the action without pins', () => {
  const action = vi.fn(), dismiss = vi.fn()
  const { rerender } = render(<TrayMenu model={model(true)} onAction={action} onDismiss={dismiss} />)
  const pins = screen.getByRole('menuitemcheckbox', { name: '显示 / 隐藏钉图' })
  expect(pins).toBeChecked()
  expect(pins.querySelector('.sp-popup-menu__trailing svg')).not.toBeNull()
  fireEvent.click(pins); expect(action).toHaveBeenCalledWith('pins')
  rerender(<TrayMenu model={model(false)} onAction={action} onDismiss={dismiss} />)
  expect(pins).not.toBeChecked(); expect(pins.querySelector('svg')).toBeNull()
  rerender(<TrayMenu model={model(false, false)} onAction={action} onDismiss={dismiss} />)
  expect(pins).toBeDisabled()
  action.mockClear(); fireEvent.click(pins); expect(action).not.toHaveBeenCalled()
})

it('uses keyboard navigation, skips disabled entries and dismisses on Escape', () => {
  const dismiss = vi.fn()
  render(<TrayMenu model={model(false, false)} onAction={vi.fn()} onDismiss={dismiss} />)
  const capture = screen.getByRole('menuitem', { name: /截图/ }), quit = screen.getByRole('menuitem', { name: '退出' })
  expect(capture).not.toHaveFocus()
  expect(quit).not.toHaveFocus()
  fireEvent.keyDown(capture, { key: 'ArrowDown' }); expect(capture).toHaveFocus()
  fireEvent.keyDown(capture, { key: 'ArrowDown' }); expect(quit).toHaveFocus()
  fireEvent.keyDown(quit, { key: 'ArrowDown' }); expect(capture).toHaveFocus()
  fireEvent.keyDown(capture, { key: 'End' }); expect(quit).toHaveFocus()
  fireEvent.keyDown(quit, { key: 'Home' }); expect(capture).toHaveFocus()
  fireEvent.keyDown(capture, { key: 'Escape' }); expect(dismiss).toHaveBeenCalledOnce()
})

it('starts at the last enabled item when ArrowUp is the first navigation key', () => {
  render(<TrayMenu model={model(false, false)} onAction={vi.fn()} onDismiss={vi.fn()} />)
  const menu = screen.getByRole('menu'), quit = screen.getByRole('menuitem', { name: '退出' })
  fireEvent.keyDown(menu, { key: 'ArrowUp' }); expect(quit).toHaveFocus()
})
