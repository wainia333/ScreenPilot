import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../desktop/context'
import { FakeDesktopPort } from '../desktop/fake-desktop'
import { VisionRouteBoundary, VisionRouteLoading } from './vision-route-state'

function BrokenVision(): never {
  throw new Error('synthetic chunk failure')
}

describe('Vision route states', () => {
  it('exposes a non-empty loading status', () => {
    render(<VisionRouteLoading />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Vision')
  })

  it('offers retry and close recovery after a render failure', () => {
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
})
