import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeDesktopPort } from '../desktop/fake-desktop'
import { App } from './app'

class MainLifecycleDesktop extends FakeDesktopPort {
  resetCount = 0

  override acknowledgeMainNavigation(requestId: number, accepted: boolean): Promise<void> {
    return super.acknowledgeMainNavigation(requestId, accepted).then(() => {
      if (accepted) {
        this.resetCount += 1
        this.emitReset('prompt-optimizer')
        this.emitRoute('prompt-optimizer')
      }
    })
  }
}

class SlowSettingsMainLifecycleDesktop extends MainLifecycleDesktop {
  override loadSettingsSnapshot(): ReturnType<FakeDesktopPort['loadSettingsSnapshot']> {
    return new Promise(() => undefined)
  }
}

class LostShortcutEventsDesktop extends FakeDesktopPort {
  override currentWindowRoute(): Promise<'prompt-optimizer'> {
    return Promise.resolve('prompt-optimizer')
  }
}

describe('App main-window navigation guard', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
  })

  it('keeps a dirty settings draft when the native navigation request is declined', async () => {
    const desktop = new FakeDesktopPort()
    render(<App port={desktop} />)
    await screen.findByRole('navigation', { name: '设置分区' })

    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    desktop.emitMainNavigationRequest({ requestId: 1, route: 'prompt-optimizer' })
    desktop.emitMainNavigationRequest({ requestId: 1, route: 'prompt-optimizer' })
    const dialog = await screen.findByRole('dialog', { name: '保存更改后切换页面？' })
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    await act(async () => Promise.resolve())
    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 1, accepted: false }])
    expect(screen.getByRole('navigation', { name: '设置分区' })).toBeInTheDocument()
    expect(dialog).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
  })

  it('accepts a clean request and remounts only after the native reset event', async () => {
    const desktop = new MainLifecycleDesktop()
    render(<App port={desktop} />)
    await screen.findByRole('navigation', { name: '设置分区' })

    desktop.emitMainNavigationRequest({ requestId: 2, route: 'prompt-optimizer' })
    await screen.findByText('提示词优化')
    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 2, accepted: true }])
    expect(desktop.resetCount).toBe(1)
  })

  it('recovers a prompt-optimizer request sent before the hidden main window listener is ready', async () => {
    const desktop = new MainLifecycleDesktop()
    desktop.emitMainNavigationRequest({ requestId: 3, route: 'prompt-optimizer' })

    render(<App port={desktop} />)

    await screen.findByText('提示词优化')
    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 3, accepted: true }])
    expect(desktop.resetCount).toBe(1)
    expect(screen.queryByRole('navigation', { name: '设置分区' })).not.toBeInTheDocument()
  })

  it('opens the prompt optimizer without waiting for the initial settings snapshot', async () => {
    const desktop = new SlowSettingsMainLifecycleDesktop()
    desktop.emitMainNavigationRequest({ requestId: 4, route: 'prompt-optimizer' })

    render(<App port={desktop} />)

    await screen.findByText('提示词优化')
    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 4, accepted: true }])
    expect(desktop.resetCount).toBe(1)
    expect(screen.queryByLabelText('正在加载设置')).not.toBeInTheDocument()
  })

  it('recovers the optimizer route when the hidden WebView missed shortcut events', async () => {
    render(<App port={new LostShortcutEventsDesktop()} />)

    await screen.findByRole('heading', { name: '提示词优化' })
    expect(screen.queryByRole('navigation', { name: '设置分区' })).not.toBeInTheDocument()
  })

  it('keeps only the newest pending native request in the settings guard', async () => {
    const desktop = new FakeDesktopPort()
    render(<App port={desktop} />)
    await screen.findByRole('navigation', { name: '设置分区' })
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))

    desktop.emitMainNavigationRequest({ requestId: 10, route: 'prompt-optimizer' })
    desktop.emitMainNavigationRequest({ requestId: 11, route: 'prompt-optimizer' })
    const dialog = await screen.findByRole('dialog', { name: '保存更改后切换页面？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    await act(async () => Promise.resolve())

    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 11, accepted: false }])
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
  })
})
