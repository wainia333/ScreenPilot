import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { DEFAULT_SETTINGS } from './defaults'
import type { AppSettings, ProviderSettings } from './types'
import { SettingsPage } from './settings-page'

class ClosingDesktop extends FakeDesktopPort {
  hides = 0
  drags = 0
  rejectNextDrag = false
  dragFailureHandled = false

  override hideWindow(): Promise<void> {
    this.hides += 1
    return Promise.resolve()
  }

  override startDragging(): Promise<void> {
    this.drags += 1
    if (this.rejectNextDrag) {
      this.rejectNextDrag = false
      return observedDragRejection(() => {
        this.dragFailureHandled = true
      })
    }
    return Promise.resolve()
  }
}

class PendingSettingsDesktop extends ClosingDesktop {
  override loadSettings(): Promise<AppSettings> {
    return new Promise(() => undefined)
  }
}

class FailingSettingsDesktop extends ClosingDesktop {
  override loadSettings(): Promise<AppSettings> {
    return Promise.reject(new Error('settings unavailable'))
  }
}

class AdministratorDesktop extends ClosingDesktop {
  override permissionStatus() {
    return Promise.resolve({
      platform: 'windows' as const,
      screenCapture: true,
      accessibility: true,
      administrator: true,
    })
  }
}

class DeferredProviderDesktop extends ClosingDesktop {
  resolveModels: ((models: string[]) => void) | null = null

  override fetchProviderModels(provider: ProviderSettings): Promise<string[]> {
    void provider
    return new Promise((resolve) => {
      this.resolveModels = resolve
    })
  }
}

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('offers save, discard and continue choices before closing dirty settings', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(await screen.findByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })
    expect(dialog).toHaveTextContent('保存并关闭')
    expect(dialog).toHaveTextContent('放弃更改')
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃更改' }))
    expect(desktop.hides).toBe(1)
  })

  it('keeps the save action in the lower-right footer', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const save = screen.getByRole('button', { name: '保存' })
    expect(save.closest('footer')).toHaveClass('settings-footer')
  })

  it('drags repeatedly from both normal title regions with the primary button only', async () => {
    const desktop = new ClosingDesktop()
    const { container } = render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const brand = container.querySelector('.settings-brand')
    const heading = screen.getByRole('heading', { name: '常规' })
    expect(brand).not.toBeNull()
    if (brand === null) throw new Error('settings brand drag region is missing')
    fireEvent.pointerDown(brand, { button: 0 })
    expect(desktop.drags).toBe(1)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(2)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(3)
    fireEvent.pointerDown(brand, { button: 1 })
    fireEvent.pointerDown(heading, { button: 2 })
    expect(desktop.drags).toBe(3)
  })

  it('does not drag from settings title actions or form controls', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    for (const control of [
      screen.getByRole('button', { name: '关闭设置' }),
      screen.getByRole('radio', { name: '深色' }),
      screen.getByRole('button', { name: '保存' }),
    ]) {
      fireEvent.pointerDown(control, { button: 0 })
    }
    expect(desktop.drags).toBe(0)
  })

  it('handles a rejected settings drag and accepts the next press', async () => {
    const desktop = new ClosingDesktop()
    desktop.rejectNextDrag = true
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '常规' })
    fireEvent.pointerDown(heading, { button: 0 })
    await act(async () => Promise.resolve())
    expect(desktop.dragFailureHandled).toBe(true)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(2)
  })

  it('keeps loading and failed settings states draggable without turning buttons into drag handles', async () => {
    const pending = new PendingSettingsDesktop()
    const pendingView = render(<DesktopProvider port={pending}><SettingsPage /></DesktopProvider>)
    const loading = screen.getByLabelText('正在加载设置')
    fireEvent.pointerDown(loading, { button: 0 })
    fireEvent.pointerDown(loading, { button: 2 })
    expect(pending.drags).toBe(1)
    pendingView.unmount()

    const failed = new FailingSettingsDesktop()
    render(<DesktopProvider port={failed}><SettingsPage /></DesktopProvider>)
    const failureHeading = await screen.findByRole('heading', { name: '无法加载设置' })
    fireEvent.pointerDown(failureHeading, { button: 0 })
    expect(failed.drags).toBe(1)
    fireEvent.pointerDown(screen.getByRole('button', { name: '重试' }), { button: 0 })
    fireEvent.pointerDown(screen.getByRole('button', { name: '关闭' }), { button: 0 })
    expect(failed.drags).toBe(1)
  })

  it('labels the screenshot translation settings section as OCR', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByRole('button', { name: 'OCR' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'OCR/截图翻译' })).not.toBeInTheDocument()
  })

  it('keeps every model selector visible when non-AI interfaces are selected', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'local',
        name: 'Local Provider',
        baseUrl: 'http://127.0.0.1:11434/v1',
        keyCount: 0,
        availableModels: ['local:model'],
        enabledModels: ['local:model'],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    expect(screen.getByRole('combobox', { name: '文本翻译 AI 模型' })).toHaveTextContent('Local Provider · local:model')
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    expect(screen.getByRole('combobox', { name: 'OCR 模型' })).toHaveTextContent('Local Provider · local:model')
    expect(screen.getByRole('combobox', { name: '截图翻译模型' })).toHaveTextContent('Local Provider · local:model')
    fireEvent.click(screen.getByRole('button', { name: 'Vision' }))
    expect(screen.getByRole('combobox', { name: 'Vision 模型' })).toHaveTextContent('Local Provider · local:model')
    fireEvent.click(screen.getByRole('button', { name: '提示词优化' }))
    expect(screen.getByRole('combobox', { name: '提示词优化模型' })).toHaveTextContent('Local Provider · local:model')
  })

  it('does not overwrite provider edits when a model fetch finishes late', async () => {
    const desktop = new DeferredProviderDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'custom',
        name: 'Original name',
        baseUrl: 'https://example.com/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    fireEvent.change(screen.getByRole('textbox', { name: '提供商名称' }), {
      target: { value: 'Edited while fetching' },
    })
    await act(async () => {
      desktop.resolveModels?.(['model-a'])
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '提供商名称' })).toHaveValue('Edited while fetching')
    expect(screen.getByRole('button', { name: 'model-a' })).toBeVisible()
  })

  it('shows the current process administrator status', async () => {
    const standard = render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    const standardStatus = await screen.findByRole('status', { name: '当前运行权限' })
    expect(standardStatus).toHaveTextContent('权限：普通用户')
    expect(standardStatus).not.toHaveTextContent('程序运行身份权限')
    expect(standardStatus.nextElementSibling).toHaveClass('settings-save-state')
    standard.unmount()
    render(<DesktopProvider port={new AdministratorDesktop()}><SettingsPage /></DesktopProvider>)
    expect(await screen.findByRole('status', { name: '当前运行权限' })).toHaveTextContent('权限：管理员')
  })
})
