import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../desktop/context'
import { FakeDesktopPort } from '../desktop/fake-desktop'
import { VisionRouteBoundary, VisionRouteLoading } from './vision-route-state'

function BrokenVision(): never {
  throw new Error('synthetic chunk failure')
}

class RejectingCloseDesktop extends FakeDesktopPort {
  override hideWindow(): Promise<void> {
    return Promise.reject(new Error('synthetic close failure'))
  }
}

describe('Vision route states', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('exposes a non-empty loading status', () => {
    render(<VisionRouteLoading />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Vision')
  })

  it('offers retry and close recovery after a render failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const retry = vi.fn()
    const desktop = new FakeDesktopPort()
    render(
      <DesktopProvider port={desktop}>
        <VisionRouteBoundary resetKey={0} onRetry={retry}>
          <BrokenVision />
        </VisionRouteBoundary>
      </DesktopProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('synthetic chunk failure')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '关闭' })).toBeVisible()
  })

  it('announces a rejected close request without leaking the native error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const desktop = new RejectingCloseDesktop()
    render(
      <DesktopProvider port={desktop}>
        <VisionRouteBoundary resetKey={0}>
          <BrokenVision />
        </VisionRouteBoundary>
      </DesktopProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(await screen.findByText('关闭 Vision 窗口失败，请重试。')).toHaveAttribute('role', 'alert')
  })
})
