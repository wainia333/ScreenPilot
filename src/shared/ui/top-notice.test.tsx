import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TopNotice } from './top-notice'

afterEach(cleanup)

it('announces only the summary, preserves opt-in diagnostics and resets details for a new failure', () => {
  const message = '保存失败：Error: Access is denied. (os error 5)\nsettings.json'
  const dismiss = vi.fn(), retry = vi.fn()
  const { rerender } = render(<TopNotice tone="error" message={message} onDismiss={dismiss}><button onClick={retry}>重试</button></TopNotice>)
  expect(screen.getByRole('alert')).toHaveAccessibleName('保存失败：权限不足，请检查文件或目录权限')
  const details = document.querySelector('.top-notice-details')
  expect(screen.getByRole('button', { name: '详情' })).toHaveAttribute('aria-expanded', 'false')
  expect(document.querySelector('pre')?.textContent).toBe(message)
  expect(document.querySelector('pre')).not.toBeVisible()
  fireEvent.click(screen.getByText('详情'))
  expect(screen.getByRole('button', { name: '详情' })).toHaveAttribute('aria-expanded', 'true')
  expect(document.querySelector('pre')).toHaveTextContent('settings.json')
  expect(details).toHaveAttribute('data-capture-interactive')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(retry).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
  expect(dismiss).toHaveBeenCalledOnce()
  rerender(<TopNotice tone="error" message="HTTP 401 Unauthorized" />)
  expect(screen.getByRole('button', { name: '详情' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('alert')).toHaveAccessibleName('认证失败，请检查 API Key')
})

it('keeps short status messages compact without a details control', () => {
  render(<TopNotice message="Saved" language="en" />)
  expect(screen.getByRole('status')).toHaveAccessibleName('Saved')
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  expect(document.querySelector('.top-notice-actions')).toBeNull()
})
