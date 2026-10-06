import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelpTooltip } from './help-tooltip'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() { /* Browser geometry is covered by Playwright. */ } disconnect() { /* No browser observer in jsdom. */ } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('keeps detailed help outside clipped cards and lets the pointer cross into it before closing', () => {
  const { container } = render(<div style={{ overflow: 'hidden' }}><HelpTooltip label="格式说明"><p>格式的详细说明</p></HelpTooltip></div>)
  const button = screen.getByRole('button', { name: '格式说明' })
  fireEvent.mouseEnter(button)
  const popup = screen.getByRole('tooltip')
  expect(popup).toHaveTextContent('格式的详细说明'); expect(container).not.toContainElement(popup)
  fireEvent.mouseLeave(button); act(() => { vi.advanceTimersByTime(70) }); fireEvent.mouseEnter(popup)
  act(() => { vi.advanceTimersByTime(200) }); expect(screen.getByRole('tooltip')).toBeInTheDocument()
  fireEvent.mouseLeave(popup); act(() => { vi.advanceTimersByTime(150) }); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('opens for keyboard and click, describes its trigger and dismisses on Escape or focus leaving', () => {
  render(<><HelpTooltip label="格式说明"><p>说明内容</p></HelpTooltip><button type="button">其他设置</button></>)
  const button = screen.getByRole('button', { name: '格式说明' })
  act(() => button.focus())
  expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
  fireEvent.mouseLeave(button); act(() => { vi.advanceTimersByTime(150) }); expect(screen.getByRole('tooltip')).toBeInTheDocument()
  fireEvent.keyDown(button, { key: 'Escape' }); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(); expect(button).toHaveFocus()
  expect(button).not.toHaveAttribute('aria-describedby')
  fireEvent.click(button); expect(screen.getByRole('tooltip')).toBeInTheDocument()
  act(() => screen.getByRole('button', { name: '其他设置' }).focus()); act(() => { vi.advanceTimersByTime(150) })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('unmounts an open popup and its pending dismissal without leaving portal content', () => {
  const { unmount } = render(<HelpTooltip label="格式说明">说明内容</HelpTooltip>)
  const button = screen.getByRole('button', { name: '格式说明' })
  fireEvent.mouseEnter(button); fireEvent.mouseLeave(button); expect(screen.getByRole('tooltip')).toBeInTheDocument()
  unmount(); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  act(() => { vi.advanceTimersByTime(300) }); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})
