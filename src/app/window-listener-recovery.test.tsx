import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../desktop/context'
import type { Unlisten, WindowRoute } from '../desktop/contract'
import { FakeDesktopPort } from '../desktop/fake-desktop'
import { WindowListenerRecovery } from './window-listener-recovery'

class ListenerDesktop extends FakeDesktopPort {
  routeAttempts = 0
  resetAttempts = 0
  routeUnlistens = 0
  resetUnlistens = 0
  routeFailures = 0
  resetFailures = 0
  routeListener: ((route: WindowRoute) => void) | null = null
  resetListener: ((route: WindowRoute) => void) | null = null

  override onRoute(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.routeAttempts += 1
    if (this.routeFailures > 0) {
      this.routeFailures -= 1
      return Promise.reject(new Error('synthetic route listener failure'))
    }
    this.routeListener = listener
    return Promise.resolve(() => {
      this.routeUnlistens += 1
      if (this.routeListener === listener) this.routeListener = null
    })
  }

  override onWindowReset(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.resetAttempts += 1
    if (this.resetFailures > 0) {
      this.resetFailures -= 1
      return Promise.reject(new Error('synthetic reset listener failure'))
    }
    this.resetListener = listener
    return Promise.resolve(() => {
      this.resetUnlistens += 1
      if (this.resetListener === listener) this.resetListener = null
    })
  }
}

class DeferredListenerDesktop extends ListenerDesktop {
  resolveRoute: ((unlisten: Unlisten) => void) | null = null

  override onRoute(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.routeAttempts += 1
    this.routeListener = listener
    return new Promise((resolve) => {
      this.resolveRoute = resolve
    })
  }
}

function ListenerHarness() {
  const [route, setRoute] = useState<WindowRoute>('settings')
  const [generation, setGeneration] = useState(0)
  const handleRoute = useCallback((nextRoute: WindowRoute) => setRoute(nextRoute), [])
  const handleWindowReset = useCallback((nextRoute: WindowRoute) => {
    setRoute(nextRoute)
    setGeneration((value) => value + 1)
  }, [])
  return (
    <>
      <h1>{`${route}-${generation}`}</h1>
      <WindowListenerRecovery onRoute={handleRoute} onWindowReset={handleWindowReset} />
    </>
  )
}

function renderListenerHarness(desktop: ListenerDesktop) {
  return render(<DesktopProvider port={desktop}><ListenerHarness /></DesktopProvider>)
}

describe('WindowListenerRecovery', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps a successful listener active when the other registration fails', async () => {
    const desktop = new ListenerDesktop()
    desktop.routeFailures = 1
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderListenerHarness(desktop)
    await act(async () => Promise.resolve())

    expect(screen.getByRole('heading', { name: 'settings-0' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接页面导航更新')
    expect(desktop.routeAttempts).toBe(1)
    expect(desktop.resetAttempts).toBe(1)

    await act(async () => {
      desktop.resetListener?.('prompt-optimizer')
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { name: 'prompt-optimizer-1' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('retries only failed registrations and preserves successful subscriptions', async () => {
    const desktop = new ListenerDesktop()
    desktop.routeFailures = 1
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderListenerHarness(desktop)
    await act(async () => Promise.resolve())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(desktop.routeAttempts).toBe(2)
    expect(desktop.resetAttempts).toBe(1)
    await act(async () => {
      desktop.routeListener?.('prompt-optimizer')
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { name: 'prompt-optimizer-0' })).toBeInTheDocument()
  })

  it('keeps failed registrations retryable after another rejected attempt', async () => {
    const desktop = new ListenerDesktop()
    desktop.routeFailures = 2
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderListenerHarness(desktop)
    await act(async () => Promise.resolve())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('synthetic route listener failure')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(desktop.routeAttempts).toBe(3)
    expect(desktop.resetAttempts).toBe(1)
  })

  it('unsubscribes installed listeners and disposes a late registration after unmount', async () => {
    const desktop = new DeferredListenerDesktop()
    const view = renderListenerHarness(desktop)
    await act(async () => Promise.resolve())
    view.unmount()

    expect(desktop.resetUnlistens).toBe(1)
    await act(async () => {
      desktop.resolveRoute?.(() => { desktop.routeUnlistens += 1 })
      await Promise.resolve()
    })
    expect(desktop.routeUnlistens).toBe(1)
  })

  it('reports a failed close from the recovery notice', async () => {
    class FailingCloseDesktop extends ListenerDesktop {
      override hideWindow(): Promise<void> {
        return Promise.reject(new Error('synthetic hide failure'))
      }
    }
    const desktop = new FailingCloseDesktop()
    desktop.resetFailures = 1
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderListenerHarness(desktop)
    await act(async () => Promise.resolve())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      await Promise.resolve()
    })
    expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('关闭窗口失败，请重试')
  })
})
