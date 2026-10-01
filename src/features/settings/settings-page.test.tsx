import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { DEFAULT_SETTINGS } from './defaults'
import type { AppSettings, ProviderSettings, SettingsExport, SettingsSecrets } from './types'
import type { MainNavigationRequest, SettingsPatch, SettingsSaveResult } from '../../desktop/contract'
import { SettingsPage } from './settings-page'
import { primaryProviderKeyDraft } from './provider-key-draft'

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

class FailingSaveDesktop extends ClosingDesktop {
  override saveSettings(): Promise<SettingsSaveResult> {
    return Promise.reject(new Error('synthetic save failure'))
  }
}

class CredentialRollbackFailureDesktop extends ClosingDesktop {
  patchCalls = 0

  override saveSettingsPatch(baseRevision: number, patch: SettingsPatch): Promise<SettingsSaveResult> {
    this.patchCalls += 1
    if (this.patchCalls >= 2) return Promise.reject(new Error('synthetic rollback failure'))
    return super.saveSettingsPatch(baseRevision, patch)
  }

  override saveAdapterKeyChanges(): Promise<void> {
    return Promise.reject(new Error('synthetic credential failure'))
  }
}

class FailingHideDesktop extends ClosingDesktop {
  override hideWindow(): Promise<void> {
    this.hides += 1
    return Promise.reject(new Error('synthetic hide failure'))
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

class StartupSettingsDesktop extends ClosingDesktop {
  constructor(private readonly loadedSettings: AppSettings) {
    super()
  }

  override loadSettings(): Promise<AppSettings> {
    return Promise.resolve(structuredClone(this.loadedSettings))
  }
}

class CountingSettingsDesktop extends ClosingDesktop {
  saves = 0

  override saveSettings(settings: AppSettings): Promise<SettingsSaveResult> {
    this.saves += 1
    return super.saveSettings(settings)
  }
}

class VisibilityAwareNoticeDesktop extends ClosingDesktop {
  override acknowledgeStartupNotice(): Promise<boolean> {
    this.startupNoticeAcknowledgeCalls += 1
    if (this.startupNoticeAcknowledgeCalls === 1) return Promise.resolve(false)
    this.startupNotice = null
    return Promise.resolve(true)
  }
}

class DeferredSaveDesktop extends ClosingDesktop {
  saves = 0
  resolveSave: (() => void) | null = null

  override saveSettings(settings: AppSettings): Promise<SettingsSaveResult> {
    this.saves += 1
    return new Promise((resolve) => {
      this.resolveSave = () => {
        this.resolveSave = null
        resolve({
          settings: structuredClone(settings),
          appliedShortcuts: { ...settings.shortcuts },
        })
      }
    })
  }
}

class DeferredNavigationPatchDesktop extends ClosingDesktop {
  resolvePatch: (() => void) | null = null

  override saveSettingsPatch(baseRevision: number, patch: SettingsPatch): Promise<SettingsSaveResult> {
    return new Promise((resolve, reject) => {
      this.resolvePatch = () => {
        this.resolvePatch = null
        super.saveSettingsPatch(baseRevision, patch).then(resolve, reject)
      }
    })
  }
}

class FailingNavigationPatchDesktop extends ClosingDesktop {
  override saveSettingsPatch(): Promise<SettingsSaveResult> {
    return Promise.reject(new Error('synthetic navigation save failure'))
  }
}

class ImportSettingsDesktop extends CountingSettingsDesktop {
  constructor(
    private readonly importedSettings: AppSettings,
    private readonly importedSecrets?: SettingsSecrets,
  ) {
    super()
  }

  override importSettings(): Promise<SettingsExport> {
    return Promise.resolve({
      type: 'screenpilot-settings-export',
      schemaVersion: 1,
      appVersion: '0.1.0',
      exportedAt: '2026-08-02T00:00:00.000Z',
      includesSecrets: this.importedSecrets !== undefined,
      settings: structuredClone(this.importedSettings),
      ...(this.importedSecrets === undefined ? {} : { secrets: structuredClone(this.importedSecrets) }),
    })
  }
}

class SettingsOperationsDesktop extends ClosingDesktop {
  directoryCalls = 0
  exportCalls: boolean[] = []
  importCalls = 0
  directoryResult: Promise<string | null> = Promise.resolve(null)
  exportResult: Promise<boolean> = Promise.resolve(false)
  importResult: Promise<SettingsExport | null> = Promise.resolve(null)

  override pickDirectory(): Promise<string | null> {
    this.directoryCalls += 1
    return this.directoryResult
  }

  override exportSettings(includeSecrets: boolean): Promise<boolean> {
    this.exportCalls.push(includeSecrets)
    return this.exportResult
  }

  override importSettings(): Promise<SettingsExport | null> {
    this.importCalls += 1
    return this.importResult
  }
}

class DeferredProviderDesktop extends ClosingDesktop {
  resolveModels: ((models: string[]) => void) | null = null
  resolveConnection: ((result: { success: boolean; error: string | null }) => void) | null = null

  override fetchProviderModels(provider: ProviderSettings, keys?: string[]): Promise<string[]> {
    void provider
    void keys
    return new Promise((resolve) => {
      this.resolveModels = resolve
    })
  }

  override testProvider(provider: ProviderSettings, keys?: string[]): Promise<{ success: boolean; error: string | null }> {
    void provider
    void keys
    return new Promise((resolve) => {
      this.resolveConnection = resolve
    })
  }
}

describe('SettingsPage', () => {
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    localStorage.clear()
  })

  it('normalizes provider draft overrides to one primary key while preserving tri-state', () => {
    expect(primaryProviderKeyDraft(undefined)).toBeUndefined()
    expect(primaryProviderKeyDraft([])).toEqual([])
    expect(primaryProviderKeyDraft(['  ', ' draft-primary ', 'backup'])).toEqual(['draft-primary'])
  })

  it('switches the complete settings shell and document language to English', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)

    fireEvent.click(await screen.findByRole('radio', { name: 'English' }))

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByText('Appearance & language')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute('lang', 'en')
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    expect(screen.getByText('This project references several excellent projects during development:')).toBeVisible()
  })

  it('keeps built-in settings configurable without row help text', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    expect(document.querySelectorAll('.setting-row__description')).toHaveLength(0)
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toHaveValue('microsoft')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    expect(document.querySelectorAll('.setting-row__description')).toHaveLength(0)
    expect(screen.getByRole('combobox', { name: 'OCR 接口' })).toHaveValue('chaoxing')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '启用OCR翻译' }))
    expect(screen.getByRole('switch', { name: '启用OCR翻译' })).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByRole('button', { name: '常规' }))
    fireEvent.click(screen.getByRole('switch', { name: '开机启动' }))
    expect(document.querySelectorAll('.setting-row__description')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'AltSnap' }))
    expect(document.querySelectorAll('.setting-row__description')).toHaveLength(0)
    expect(document.querySelector('.altsnap-hints')).toHaveTextContent('起始拖动方向决定缩放边界')
  })

  it('retains selected AI models and interfaces after removing row help text', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.providers = [{
      id: 'gateway',
      name: 'Gateway',
      baseUrl: 'https://gateway.example/v1',
      protocol: 'responses',
      keyCount: 0,
      availableModels: ['vision-model'],
      enabledModels: ['vision-model'],
    }]
    const selection = { providerId: 'gateway', model: 'vision-model' }
    settings.translation = {
      ...settings.translation,
      method: 'ai',
      aiEnabled: true,
      aiModel: selection,
    }
    settings.screenshotTranslation = {
      ...settings.screenshotTranslation,
      ocrAiEnabled: true,
      ocrMethod: 'ai',
      ocrModel: selection,
      translationAiEnabled: true,
      translationMethod: 'ai',
      translationModel: selection,
    }
    const desktop = new StartupSettingsDesktop(settings)
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toHaveValue('ai')
    expect(screen.getByRole('combobox', { name: '文本翻译 AI 模型' })).toHaveValue(JSON.stringify(selection))
    expect(document.querySelectorAll('.setting-row__description')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    expect(screen.getByRole('combobox', { name: 'OCR 接口' })).toHaveValue('ai')
    expect(screen.getByRole('combobox', { name: 'OCR翻译接口' })).toHaveValue('ai')
    expect(screen.getByRole('combobox', { name: 'OCR 模型' })).toHaveValue(JSON.stringify(selection))
    expect(document.querySelectorAll('.setting-row__description')).toHaveLength(0)
  })

  it('keeps a startup recovery notice until the visible settings window acknowledges it', async () => {
    const desktop = new VisibilityAwareNoticeDesktop()
    desktop.startupNotice = '设置文件已隔离，当前使用默认设置。'
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)

    expect(await screen.findByText('设置文件已隔离，当前使用默认设置。')).toBeVisible()
    expect(desktop.startupNoticeAcknowledgeCalls).toBe(1)
    expect(desktop.startupNotice).not.toBeNull()

    fireEvent.focus(window)
    await act(async () => Promise.resolve())

    expect(desktop.startupNoticeAcknowledgeCalls).toBe(2)
    expect(desktop.startupNotice).toBeNull()
    expect(screen.getByText('设置文件已隔离，当前使用默认设置。')).toBeVisible()
  })

  it('offers save, discard and continue choices before closing dirty settings', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(await screen.findByRole('radio', { name: '深色' }))
    const closeSettings = screen.getByRole('button', { name: '关闭设置' })
    closeSettings.focus()
    fireEvent.click(closeSettings)
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })
    expect(dialog).toHaveClass('decision-dialog', 'unsaved-close-dialog')
    expect(dialog.parentElement).toHaveClass('dialog-backdrop', 'unsaved-close-backdrop')
    expect(dialog).toHaveTextContent('保存并关闭')
    expect(dialog).toHaveTextContent('放弃更改')
    const continueEditing = screen.getByRole('button', { name: '继续编辑' })
    await act(async () => Promise.resolve())
    expect(document.activeElement).toBe(continueEditing)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '保存并关闭' }))
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(continueEditing)
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => Promise.resolve())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭设置' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃更改' }))
    expect(desktop.hides).toBe(1)
  })

  it('holds a native route request while saving and acknowledges only after save succeeds', async () => {
    const desktop = new DeferredNavigationPatchDesktop()
    const onResolved = vi.fn()
    const view = render(<DesktopProvider port={desktop}><SettingsPage onNavigationRequestResolved={onResolved} /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    const request: MainNavigationRequest = { requestId: 41, route: 'prompt-optimizer' }
    view.rerender(<DesktopProvider port={desktop}><SettingsPage navigationRequest={request} onNavigationRequestResolved={onResolved} /></DesktopProvider>)
    const dialog = await screen.findByRole('dialog', { name: '保存更改后切换页面？' })

    fireEvent.click(within(dialog).getByRole('button', { name: '保存并切换' }))
    expect(desktop.mainNavigationAcks).toEqual([])
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    await act(async () => {
      desktop.resolvePatch?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 41, accepted: true }])
    expect(onResolved).toHaveBeenCalledWith(41)
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
  })

  it('keeps the navigation guard and credential draft after a navigation save failure', async () => {
    const desktop = new FailingNavigationPatchDesktop()
    const view = render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'navigation-api' } })
    fireEvent.change(screen.getByLabelText('百度 OCR Secret Key'), { target: { value: 'navigation-secret' } })
    const request: MainNavigationRequest = { requestId: 42, route: 'prompt-optimizer' }
    view.rerender(<DesktopProvider port={desktop}><SettingsPage navigationRequest={request} /></DesktopProvider>)
    const dialog = await screen.findByRole('dialog', { name: '保存更改后切换页面？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并切换' }))
    await act(async () => Promise.resolve())

    expect(within(dialog).getByRole('alert')).toHaveTextContent('保存失败')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('synthetic navigation save failure')
    expect(desktop.mainNavigationAcks).toEqual([])
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('navigation-api')
    expect(screen.getByLabelText('百度 OCR Secret Key')).toHaveValue('navigation-secret')
  })

  it('treats an import waiting for confirmation as dirty for native navigation', async () => {
    const desktop = new ImportSettingsDesktop(structuredClone(DEFAULT_SETTINGS))
    const view = render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    fireEvent.click(screen.getByRole('button', { name: '导入配置' }))
    await act(async () => Promise.resolve())
    const importDialog = screen.getByRole('dialog', { name: '覆盖当前未保存内容？' })
    const request: MainNavigationRequest = { requestId: 43, route: 'prompt-optimizer' }
    view.rerender(<DesktopProvider port={desktop}><SettingsPage navigationRequest={request} /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByRole('dialog', { name: '覆盖当前未保存内容？' })).toBe(importDialog)
    expect(desktop.mainNavigationAcks).toEqual([])

    fireEvent.click(within(importDialog).getByRole('button', { name: '取消' }))
    const navigationDialog = await screen.findByRole('dialog', { name: '保存更改后切换页面？' })
    fireEvent.click(within(navigationDialog).getByRole('button', { name: '继续编辑' }))
    await act(async () => Promise.resolve())
    expect(desktop.mainNavigationAcks).toEqual([{ requestId: 43, accepted: false }])
    fireEvent.click(screen.getByRole('button', { name: '常规' }))
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
  })

  it('keeps the close dialog open with a validation summary and locates an invalid URL', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const baseUrl = screen.getByRole('textbox', { name: '提供商 Base URL' })
    fireEvent.change(baseUrl, { target: { value: 'not a url' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '保存并关闭' }))
      await Promise.resolve()
    })

    const error = within(dialog).getByRole('alert')
    expect(error).toHaveTextContent('Provider URL 无效')
    expect(error).toHaveTextContent('返回编辑并定位问题')
    expect(document.activeElement).toBe(error)
    expect(desktop.hides).toBe(0)

    fireEvent.click(within(error).getByRole('button', { name: '返回编辑并定位问题' }))
    await act(async () => Promise.resolve())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('.settings-toolbar h1')).toHaveTextContent('模型提供商')
    expect(document.activeElement).toBe(baseUrl)
  })

  it('summarizes shortcut and archive validation failures inside the close dialog', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const archive = screen.getByRole('switch', { name: '截图自动归档' })
    fireEvent.click(archive)
    fireEvent.click(screen.getByRole('button', { name: '录制文本翻译快捷键' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '录制文本翻译快捷键' }), { key: 'F3' })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '保存并关闭' }))
      await Promise.resolve()
    })

    const error = within(dialog).getByRole('alert')
    expect(error).toHaveTextContent('快捷键存在冲突')
    expect(error).toHaveTextContent('选择归档目录')
    expect(within(dialog).getByRole('button', { name: '返回编辑并定位问题' })).toBeVisible()
    expect(desktop.hides).toBe(0)
  })

  it('keeps credential drafts and focuses the modal error after a credential save failure', async () => {
    const desktop = new ClosingDesktop()
    desktop.adapterKeySaveError = 'synthetic credential failure'
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'credential-api' } })
    fireEvent.change(screen.getByLabelText('百度 OCR Secret Key'), { target: { value: 'credential-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '保存并关闭' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const error = within(dialog).getByRole('alert')
    expect(error).toHaveTextContent('凭据保存失败')
    expect(error).toHaveTextContent('synthetic credential failure')
    expect(document.activeElement).toBe(error)
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('credential-api')
    expect(desktop.hides).toBe(0)
  })

  it('reports rollback failures separately while retaining the unsaved close draft', async () => {
    const desktop = new CredentialRollbackFailureDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'rollback-api' } })
    fireEvent.change(screen.getByLabelText('百度 OCR Secret Key'), { target: { value: 'rollback-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '保存并关闭' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const error = within(dialog).getByRole('alert')
    expect(error).toHaveTextContent('设置回滚失败')
    expect(error).toHaveTextContent('synthetic credential failure')
    expect(error).toHaveTextContent('synthetic rollback failure')
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('rollback-api')
    expect(desktop.hides).toBe(0)
  })

  it('shows close failures for clean and discarded settings without leaking rejected promises', async () => {
    const desktop = new FailingHideDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('synthetic hide failure')

    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '放弃更改' }))
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('synthetic hide failure')
    expect(screen.getByRole('radio', { name: '系统' })).toBeChecked()
    expect(desktop.hides).toBe(2)
  })

  it('keeps the import confirmation on the base dialog presentation', async () => {
    const desktop = new ImportSettingsDesktop(structuredClone(DEFAULT_SETTINGS))
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(await screen.findByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    fireEvent.click(screen.getByRole('button', { name: '导入配置' }))
    await act(async () => Promise.resolve())
    const dialog = screen.getByRole('dialog', { name: '覆盖当前未保存内容？' })
    expect(dialog).toHaveClass('decision-dialog')
    expect(dialog).not.toHaveClass('unsaved-close-dialog')
    expect(dialog.parentElement).toHaveClass('dialog-backdrop')
    expect(dialog.parentElement).not.toHaveClass('unsaved-close-backdrop')
  })

  it('catches directory picker failures, blocks duplicate work, and keeps cancellation silent', async () => {
    const desktop = new SettingsOperationsDesktop()
    let rejectDirectory: ((reason?: unknown) => void) | undefined
    desktop.directoryResult = new Promise((_resolve, reject) => {
      rejectDirectory = reject
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('switch', { name: '截图自动归档' }))
    const chooseDirectory = screen.getByRole('button', { name: '选择目录' })

    fireEvent.click(chooseDirectory)

    expect(chooseDirectory).toBeDisabled()
    expect(chooseDirectory).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '关闭设置' })).toBeDisabled()
    fireEvent.click(chooseDirectory)
    expect(desktop.directoryCalls).toBe(1)

    await act(async () => {
      rejectDirectory?.(new Error('synthetic directory failure'))
      await Promise.resolve()
    })

    expect(screen.getByText('选择目录失败：synthetic directory failure')).toHaveAttribute('role', 'alert')
    expect(chooseDirectory).toBeEnabled()
    expect(chooseDirectory).toHaveAttribute('aria-busy', 'false')

    desktop.directoryResult = Promise.resolve(null)
    await act(async () => {
      fireEvent.click(chooseDirectory)
      await Promise.resolve()
    })
    expect(screen.queryByText(/选择目录失败/u)).not.toBeInTheDocument()
    expect(chooseDirectory).toHaveTextContent('选择目录')

    desktop.directoryResult = Promise.resolve('D:\\ScreenPilot shots')
    await act(async () => {
      fireEvent.click(chooseDirectory)
      await Promise.resolve()
    })
    expect(chooseDirectory).toHaveTextContent('D:\\ScreenPilot shots')
    expect(desktop.directoryCalls).toBe(3)
  })

  it('catches export failures, serializes file dialogs, and does not report cancellation as success', async () => {
    const desktop = new SettingsOperationsDesktop()
    let rejectExport: ((reason?: unknown) => void) | undefined
    desktop.exportResult = new Promise((_resolve, reject) => {
      rejectExport = reject
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    const exportButton = screen.getByRole('button', { name: '导出配置' })
    const importButton = screen.getByRole('button', { name: '导入配置' })

    fireEvent.click(exportButton)

    expect(exportButton).toBeDisabled()
    expect(exportButton).toHaveAttribute('aria-busy', 'true')
    expect(importButton).toBeDisabled()
    fireEvent.click(exportButton)
    expect(desktop.exportCalls).toEqual([false])

    await act(async () => {
      rejectExport?.(new Error('synthetic export failure'))
      await Promise.resolve()
    })
    expect(screen.getByText('配置导出失败：synthetic export failure')).toHaveAttribute('role', 'alert')

    desktop.exportResult = Promise.resolve(false)
    await act(async () => {
      fireEvent.click(exportButton)
      await Promise.resolve()
    })
    expect(screen.queryByText(/配置导出失败/u)).not.toBeInTheDocument()
    expect(screen.queryByText('配置已导出')).not.toBeInTheDocument()

    desktop.exportResult = Promise.resolve(true)
    await act(async () => {
      fireEvent.click(exportButton)
      await Promise.resolve()
    })
    expect(screen.getByText('配置已导出')).toHaveAttribute('role', 'status')
    expect(desktop.exportCalls).toEqual([false, false, false])
  })

  it('catches import failures, keeps cancellation silent, and remains retryable', async () => {
    const desktop = new SettingsOperationsDesktop()
    let rejectImport: ((reason?: unknown) => void) | undefined
    desktop.importResult = new Promise((_resolve, reject) => {
      rejectImport = reject
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    const importButton = screen.getByRole('button', { name: '导入配置' })

    fireEvent.click(importButton)
    expect(importButton).toBeDisabled()
    expect(importButton).toHaveAttribute('aria-busy', 'true')
    await act(async () => {
      rejectImport?.(new Error('synthetic import failure'))
      await Promise.resolve()
    })
    expect(screen.getByText('配置导入失败：synthetic import failure')).toHaveAttribute('role', 'alert')
    expect(importButton).toBeEnabled()
    expect(importButton).toHaveAttribute('aria-busy', 'false')

    desktop.importResult = Promise.resolve(null)
    await act(async () => {
      fireEvent.click(importButton)
      await Promise.resolve()
    })
    expect(screen.queryByText(/配置导入失败/u)).not.toBeInTheDocument()
    expect(desktop.importCalls).toBe(2)
  })

  it('keeps the save action in the lower-right footer', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const save = screen.getByRole('button', { name: '保存' })
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(save.closest('footer')).toHaveClass('settings-footer')
    expect(save).toHaveClass('settings-footer-button')
    expect(cancel).toHaveClass('settings-footer-button')
    expect(save.classList.contains('settings-footer-button')).toBe(cancel.classList.contains('settings-footer-button'))
  })

  it('cancels draft changes without saving and restores the loaded baseline', async () => {
    const desktop = new CountingSettingsDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel).toHaveClass('secondary-button', 'settings-footer-button')
    expect(cancel).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    expect(cancel).toBeEnabled()
    expect(cancel).toHaveClass('secondary-button', 'settings-footer-button')
    fireEvent.click(cancel)
    expect(screen.getByRole('radio', { name: '系统' })).toBeChecked()
    expect(cancel).toBeDisabled()
    expect(screen.getByText('所有更改已保存')).toBeVisible()
    expect(desktop.saves).toBe(0)
  })

  it('saves, migrates, and cancels source language settings', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    const source = screen.getByRole('combobox', { name: '源语言' })
    expect(source).toHaveValue('auto')
    fireEvent.change(source, { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    expect((await desktop.loadSettings()).translation.sourceLanguage).toBe('en')
    fireEvent.change(screen.getByRole('combobox', { name: '源语言' }), { target: { value: 'zh-CN' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('combobox', { name: '源语言' })).toHaveValue('en')
  })

  it('merges a shared-window translation update while saving an unrelated theme edit', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    await act(async () => {
      await desktop.updateTranslationSettings({ targetLanguage: 'ja' })
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())

    const persisted = await desktop.loadSettings()
    expect(persisted.theme).toBe('dark')
    expect(persisted.translation.targetLanguage).toBe('ja')
  })

  it('keeps a same-field shared-window conflict recoverable instead of overwriting it', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    const target = screen.getByRole('combobox', { name: '目标语言' })
    fireEvent.change(target, { target: { value: 'en' } })

    await act(async () => {
      await desktop.updateTranslationSettings({ targetLanguage: 'ja' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('其他窗口刚刚修改了设置')

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    expect((await desktop.loadSettings()).translation.targetLanguage).toBe('ja')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('ja')
  })

  it('shows a replayable save-success toast and dismisses it after a short delay', async () => {
    vi.useFakeTimers()
    const desktop = new CountingSettingsDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())

    const firstToastRegion = screen.getByRole('status', { name: '设置已保存并立即生效' })
    const firstToast = firstToastRegion.querySelector<HTMLElement>('.save-success-toast')
    expect(firstToastRegion).toHaveClass('save-success-toast-region')
    expect(firstToastRegion.parentElement).toBe(document.querySelector('.settings-window'))
    expect(firstToastRegion).toHaveAttribute('aria-live', 'polite')
    expect(firstToast).not.toBeNull()
    expect(firstToast).toHaveAttribute('data-toast-sequence', '1')
    expect(firstToast).toHaveAttribute('data-toast-phase', 'visible')
    expect(screen.queryByText('设置已保存并立即生效', { selector: '.settings-scroll .status-banner' })).not.toBeInTheDocument()

    await act(() => { vi.advanceTimersByTime(2_000); return Promise.resolve() })
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '系统' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await Promise.resolve()
    })
    await act(async () => Promise.resolve())
    expect(desktop.saves).toBe(2)

    const replayedToastRegion = screen.getByRole('status', { name: '设置已保存并立即生效' })
    const replayedToast = replayedToastRegion.querySelector<HTMLElement>('.save-success-toast')
    expect(replayedToast).not.toBeNull()
    expect(replayedToast).toHaveAttribute('data-toast-sequence', '2')
    expect(replayedToast).toHaveAttribute('data-toast-phase', 'visible')
    await act(() => { vi.advanceTimersByTime(3_200); return Promise.resolve() })
    const leavingToast = replayedToastRegion.querySelector<HTMLElement>('.save-success-toast')
    expect(leavingToast).toHaveAttribute('data-toast-phase', 'leaving')
    await act(() => { vi.advanceTimersByTime(199); return Promise.resolve() })
    expect(replayedToastRegion.querySelector('.save-success-toast')).toBeInTheDocument()
    await act(() => { vi.advanceTimersByTime(1); return Promise.resolve() })
    expect(replayedToastRegion.querySelector('.save-success-toast')).not.toBeInTheDocument()
  })

  it('uses the successful save as the cancel baseline and blocks cancel during saving', async () => {
    const desktop = new DeferredSaveDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    const save = screen.getByRole('button', { name: '保存' })
    const cancel = screen.getByRole('button', { name: '取消' })
    fireEvent.click(save)
    expect(screen.getByRole('button', { name: '保存中…' })).toHaveClass('settings-footer-button')
    expect(cancel).toHaveClass('settings-footer-button')
    expect(cancel).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: '系统' }))
    await act(async () => {
      desktop.resolveSave?.()
      await Promise.resolve()
    })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
    expect(cancel).toBeDisabled()
    expect(desktop.saves).toBe(1)
  })

  it('blocks credential conflicts, close and import while saving', async () => {
    const desktop = new DeferredSaveDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const keys = screen.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
    fireEvent.change(keys, { target: { value: 'saving-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(keys).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '关闭设置' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    expect(screen.getByRole('button', { name: '导入配置' })).toBeDisabled()
    await act(async () => {
      desktop.resolveSave?.()
      await Promise.resolve()
    })
  })

  it('updates the provider key count baseline when an ordinary edit overlaps saving', async () => {
    const desktop = new DeferredSaveDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const keys = screen.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
    fireEvent.change(keys, { target: { value: 'overlap-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByRole('button', { name: '常规' }))
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    await act(async () => {
      desktop.resolveSave?.()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    expect(screen.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })).toHaveAttribute(
      'placeholder',
      '已安全保存 1 个密钥',
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('cancels an imported draft back to the last loaded settings', async () => {
    const desktop = new ImportSettingsDesktop({ ...structuredClone(DEFAULT_SETTINGS), theme: 'dark' })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    fireEvent.click(screen.getByRole('button', { name: '导入配置' }))
    await act(async () => Promise.resolve())
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    expect(screen.getByRole('radio', { name: '系统' })).toBeChecked()
    expect(cancel).toBeDisabled()
    expect(desktop.saves).toBe(0)
  })

  it('saves imported provider and adapter secrets through the combined command', async () => {
    const removedProvider: ProviderSettings = {
      id: 'removed-provider',
      name: 'Removed Provider',
      baseUrl: 'https://removed.example.com/v1',
      protocol: 'responses',
      keyCount: 1,
      availableModels: [],
      enabledModels: [],
    }
    const provider: ProviderSettings = {
      id: 'imported-provider',
      name: 'Imported Provider',
      baseUrl: 'https://example.com/v1',
      protocol: 'responses',
      keyCount: 1,
      availableModels: ['model'],
      enabledModels: ['model'],
    }
    const secrets: SettingsSecrets = {
      schemaVersion: 1,
      providers: { [provider.id]: ['provider-secret'] },
      adapters: { 'adapter-baidu-ocr': ['ocr-api-key', 'ocr-secret-key'] },
    }
    const desktop = new ImportSettingsDesktop({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [provider],
    }, secrets)
    const initialSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [removedProvider],
    }
    await desktop.saveSettings(initialSettings)
    await desktop.setProviderKeys(removedProvider.id, ['old-provider-secret'])
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    fireEvent.click(screen.getByRole('button', { name: '导入配置' }))
    await act(async () => Promise.resolve())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await Promise.resolve()
    })

    expect(desktop.importedSecretsSaveCalls).toEqual([{
      secrets,
      providerDeletionIds: [removedProvider.id],
    }])
    expect(desktop.providerKeySaveCalls).toEqual([])
    expect(await desktop.providerKeyCount(removedProvider.id)).toBe(0)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('rolls settings back when the combined imported-secrets save fails', async () => {
    const removedProvider: ProviderSettings = {
      id: 'removed-provider',
      name: 'Removed Provider',
      baseUrl: 'https://removed.example.com/v1',
      protocol: 'responses',
      keyCount: 1,
      availableModels: [],
      enabledModels: [],
    }
    const provider: ProviderSettings = {
      id: 'imported-provider',
      name: 'Imported Provider',
      baseUrl: 'https://example.com/v1',
      protocol: 'responses',
      keyCount: 1,
      availableModels: [],
      enabledModels: [],
    }
    const secrets: SettingsSecrets = {
      schemaVersion: 1,
      providers: { [provider.id]: ['provider-secret'] },
      adapters: { 'adapter-baidu-ocr': ['ocr-api-key', 'ocr-secret-key'] },
    }
    const desktop = new ImportSettingsDesktop({
      ...structuredClone(DEFAULT_SETTINGS),
      theme: 'dark',
      providers: [provider],
    }, secrets)
    const initialSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [removedProvider],
    }
    await desktop.saveSettings(initialSettings)
    await desktop.setProviderKeys(removedProvider.id, ['old-provider-secret'])
    desktop.importedSecretsSaveError = 'synthetic credential failure'
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '关于' }))
    fireEvent.click(screen.getByRole('button', { name: '导入配置' }))
    await act(async () => Promise.resolve())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(desktop.importedSecretsSaveCalls).toEqual([{
      secrets,
      providerDeletionIds: [removedProvider.id],
    }])
    expect(desktop.saves).toBe(3)
    expect(await desktop.loadSettings()).toEqual(initialSettings)
    expect(await desktop.providerKeyCount(removedProvider.id)).toBe(1)
    expect(screen.getByText(/保存失败.*synthetic credential failure/u)).toBeInTheDocument()
  })

  it('offers a default reset for every editable prompt field', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const fields = [
      { section: '翻译', label: '大模型翻译系统提示词', value: DEFAULT_SETTINGS.translation.prompt },
      { section: 'OCR', label: 'OCR 提示词', value: DEFAULT_SETTINGS.screenshotTranslation.ocrPrompt },
      { section: 'OCR', label: 'OCR翻译提示词', value: DEFAULT_SETTINGS.screenshotTranslation.translationPrompt },
      { section: 'Vision', label: 'Vision 系统提示词', value: DEFAULT_SETTINGS.vision.systemPrompt },
      { section: 'Vision', label: 'Vision 问答提示词', value: DEFAULT_SETTINGS.vision.questionPrompt },
      { section: '提示词优化', label: '优化器系统提示词', value: DEFAULT_SETTINGS.promptOptimizer.systemPrompt },
      { section: '提示词优化', label: '优化提示词', value: DEFAULT_SETTINGS.promptOptimizer.optimizePrompt },
    ]
    for (const field of fields) {
      fireEvent.click(screen.getByRole('button', { name: field.section }))
      const prompt = screen.getByRole('textbox', { name: field.label })
      const reset = screen.getByRole('button', { name: `恢复默认：${field.label}` })
      const group = prompt.closest('.setting-group')
      expect(group).not.toBeNull()
      expect(group?.querySelectorAll('h2')).toHaveLength(1)
      expect(group?.querySelectorAll('.prompt-field-label')).toHaveLength(0)
      expect(reset.parentElement).toHaveClass('setting-group__heading')
      expect(reset.closest('.prompt-field-shell')).toBeNull()
      expect(prompt).toHaveValue(field.value)
      expect(reset).toBeDisabled()
      fireEvent.change(prompt, { target: { value: `${field.label} custom` } })
      expect(reset).toBeEnabled()
      fireEvent.click(reset)
      expect(prompt).toHaveValue(field.value)
      expect(reset).toBeDisabled()
    }
  })

  it('keeps a saved custom prompt as the cancel baseline after resetting to default', async () => {
    const desktop = new CountingSettingsDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    const prompt = screen.getByRole('textbox', { name: '大模型翻译系统提示词' })
    const reset = screen.getByRole('button', { name: '恢复默认：大模型翻译系统提示词' })
    const save = screen.getByRole('button', { name: '保存' })
    const cancel = screen.getByRole('button', { name: '取消' })
    fireEvent.change(prompt, { target: { value: 'saved custom translation prompt' } })
    fireEvent.click(save)
    await act(async () => Promise.resolve())
    expect(cancel).toBeDisabled()
    fireEvent.click(reset)
    expect(prompt).toHaveValue(DEFAULT_SETTINGS.translation.prompt)
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    expect(prompt).toHaveValue('saved custom translation prompt')
    expect(cancel).toBeDisabled()
    expect(desktop.saves).toBe(1)
  })

  it('drags repeatedly from both normal title regions with the primary button only', async () => {
    const desktop = new ClosingDesktop()
    const { container } = render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const brand = container.querySelector('.settings-brand')
    const heading = screen.getByRole('heading', { name: '常规' })
    const toolbar = heading.closest('.settings-toolbar')
    expect(brand).not.toBeNull()
    expect(toolbar).not.toBeNull()
    if (brand === null) throw new Error('settings brand drag region is missing')
    if (toolbar === null) throw new Error('settings toolbar drag region is missing')
    fireEvent.pointerDown(brand, { button: 0 })
    expect(desktop.drags).toBe(1)
    fireEvent.pointerDown(toolbar, { button: 0 })
    expect(desktop.drags).toBe(2)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(3)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(4)
    fireEvent.pointerDown(brand, { button: 1 })
    fireEvent.pointerDown(heading, { button: 2 })
    expect(desktop.drags).toBe(4)
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

  it('keeps a native close failure visible on the settings load-error screen', async () => {
    class FailingLoadAndHideDesktop extends FailingSettingsDesktop {
      override hideWindow(): Promise<void> {
        this.hides += 1
        return Promise.reject(new Error('synthetic load-state hide failure'))
      }
    }
    const desktop = new FailingLoadAndHideDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    expect(await screen.findByText('Error: settings unavailable')).toBeVisible()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      await Promise.resolve()
    })

    expect(screen.getByText('synthetic load-state hide failure')).toBeVisible()
    expect(desktop.hides).toBe(1)
  })

  it('labels the screenshot translation settings section as OCR', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByRole('button', { name: 'OCR' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'OCR/OCR翻译' })).not.toBeInTheDocument()
  })

  it('uses lowercase thinking effort options for Vision, OCR and prompt optimization', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    const optionData = (select: HTMLElement) => Array.from(select.querySelectorAll('option')).map((option) => ({
      label: option.textContent,
      value: option.getAttribute('value') ?? '',
    }))
    const fullEfforts = ['low', 'medium', 'high', 'xhigh', 'max']
    const screenshotEfforts = ['low', 'medium', 'high', 'xhigh']
    const assertEfforts = (select: HTMLElement, values: string[]) => {
      expect(optionData(select)).toEqual(values.map((value) => ({ label: value, value })))
      expect(select.textContent).not.toMatch(/[低中高极]/u)
      expect(select.textContent).not.toContain('MAX')
    }

    fireEvent.click(screen.getByRole('button', { name: 'Vision' }))
    const vision = screen.getByRole('combobox', { name: 'Vision 思考强度' })
    assertEfforts(vision, fullEfforts)
    fireEvent.change(vision, { target: { value: 'max' } })

    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.click(screen.getByRole('switch', { name: '显示思考过程' }))
    const screenshot = screen.getByRole('combobox', { name: 'OCR翻译思考强度' })
    assertEfforts(screenshot, screenshotEfforts)
    fireEvent.change(screenshot, { target: { value: 'xhigh' } })

    fireEvent.click(screen.getByRole('button', { name: '提示词优化' }))
    const optimizer = screen.getByRole('combobox', { name: '提示词优化思考强度' })
    assertEfforts(optimizer, fullEfforts)
    fireEvent.change(optimizer, { target: { value: 'max' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    const saved = await desktop.loadSettings()
    expect(saved.vision.thinkingEffort).toBe('max')
    expect(saved.screenshotTranslation.thinkingEffort).toBe('xhigh')
    expect(saved.promptOptimizer.thinkingEffort).toBe('max')
  })

  it('gates AI interfaces and model selectors by independent switches and selections', async () => {
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
    expect(screen.queryByRole('combobox', { name: '文本翻译 AI 模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'AI' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    const translationModel = screen.getByRole('combobox', { name: '文本翻译 AI 模型' })
    expect(translationModel).toHaveTextContent('Local Provider · local:model')
    expect(screen.queryByRole('option', { name: 'AI' })).not.toBeInTheDocument()
    fireEvent.change(translationModel, { target: { value: JSON.stringify({ providerId: 'local', model: 'local:model' }) } })
    expect(screen.getByRole('option', { name: 'AI' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    expect(screen.queryByRole('combobox', { name: 'OCR 模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'OCR翻译模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'AI 视觉 OCR' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'AI' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型 OCR' }))
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    const ocrModel = screen.getByRole('combobox', { name: 'OCR 模型' })
    const screenshotTranslationModel = screen.getByRole('combobox', { name: 'OCR翻译模型' })
    fireEvent.change(ocrModel, { target: { value: JSON.stringify({ providerId: 'local', model: 'local:model' }) } })
    fireEvent.change(screenshotTranslationModel, { target: { value: JSON.stringify({ providerId: 'local', model: 'local:model' }) } })
    expect(screen.getByRole('option', { name: 'AI 视觉 OCR' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'AI' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Vision' }))
    expect(screen.getByRole('combobox', { name: 'Vision 模型' })).toHaveTextContent('Local Provider · local:model')
    fireEvent.click(screen.getByRole('button', { name: '提示词优化' }))
    expect(screen.getByRole('combobox', { name: '提示词优化模型' })).toHaveTextContent('Local Provider · local:model')
  })

  it('keeps each enabled AI model row directly before its interface row', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    const rowFor = (group: HTMLElement, label: string) => {
      const row = Array.from(group.querySelectorAll<HTMLElement>('.setting-row')).find(
        (candidate) => candidate.querySelector('.setting-row__label')?.textContent === label,
      )
      if (row === undefined) throw new Error(`setting row missing: ${label}`)
      return row
    }
    const activeGroup = (heading: string) => {
      const group = screen.getByRole('heading', { name: heading }).closest<HTMLElement>('.setting-group')
      if (group === null) throw new Error(`setting group missing: ${heading}`)
      return group
    }

    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    let translationGroup = activeGroup('翻译行为')
    let translationToggleRow = rowFor(translationGroup, '开启大模型翻译')
    let translationInterfaceRow = rowFor(translationGroup, '翻译接口')
    expect(translationToggleRow.nextElementSibling).toBe(translationInterfaceRow)
    expect(screen.queryByRole('combobox', { name: '文本翻译 AI 模型' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    translationGroup = activeGroup('翻译行为')
    translationToggleRow = rowFor(translationGroup, '开启大模型翻译')
    const translationModelRow = screen.getByRole('combobox', { name: '文本翻译 AI 模型' }).closest<HTMLElement>('.setting-row')
    translationInterfaceRow = rowFor(translationGroup, '翻译接口')
    expect(translationModelRow).not.toBeNull()
    expect(translationToggleRow.nextElementSibling).toBe(translationModelRow)
    expect(translationModelRow?.nextElementSibling).toBe(translationInterfaceRow)

    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    let screenshotGroup = activeGroup('OCR翻译')
    let ocrToggleRow = rowFor(screenshotGroup, '开启大模型 OCR')
    let ocrInterfaceRow = rowFor(screenshotGroup, 'OCR 接口')
    let screenshotTranslationToggleRow = rowFor(screenshotGroup, '开启大模型翻译')
    let screenshotTranslationInterfaceRow = rowFor(screenshotGroup, '翻译接口')
    expect(ocrToggleRow.nextElementSibling).toBe(ocrInterfaceRow)
    expect(screenshotTranslationToggleRow.nextElementSibling).toBe(screenshotTranslationInterfaceRow)
    expect(screen.queryByRole('combobox', { name: 'OCR 模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'OCR翻译模型' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '开启大模型 OCR' }))
    screenshotGroup = activeGroup('OCR翻译')
    ocrToggleRow = rowFor(screenshotGroup, '开启大模型 OCR')
    ocrInterfaceRow = rowFor(screenshotGroup, 'OCR 接口')
    const ocrModelRow = screen.getByRole('combobox', { name: 'OCR 模型' }).closest<HTMLElement>('.setting-row')
    expect(ocrModelRow).not.toBeNull()
    expect(ocrToggleRow.nextElementSibling).toBe(ocrModelRow)
    expect(ocrModelRow?.nextElementSibling).toBe(ocrInterfaceRow)

    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    screenshotGroup = activeGroup('OCR翻译')
    screenshotTranslationToggleRow = rowFor(screenshotGroup, '开启大模型翻译')
    screenshotTranslationInterfaceRow = rowFor(screenshotGroup, '翻译接口')
    const screenshotTranslationModelRow = screen
      .getByRole('combobox', { name: 'OCR翻译模型' })
      .closest<HTMLElement>('.setting-row')
    expect(screenshotTranslationModelRow).not.toBeNull()
    expect(screenshotTranslationToggleRow.nextElementSibling).toBe(screenshotTranslationModelRow)
    expect(screenshotTranslationModelRow?.nextElementSibling).toBe(screenshotTranslationInterfaceRow)
  })

  it('persists switch fallbacks, restores on cancel, and clears deleted models', async () => {
    const desktop = new ClosingDesktop()
    const provider = {
      id: 'ai-provider',
      name: 'AI Provider',
      baseUrl: 'https://example.com/v1',
      keyCount: 0,
      availableModels: ['model-a'],
      enabledModels: ['model-a'],
    }
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [provider],
      translation: {
        ...DEFAULT_SETTINGS.translation,
        aiEnabled: true,
        method: 'ai',
        aiModel: { providerId: provider.id, model: 'model-a' },
      },
      screenshotTranslation: {
        ...DEFAULT_SETTINGS.screenshotTranslation,
        ocrAiEnabled: true,
        ocrMethod: 'ai',
        ocrModel: { providerId: provider.id, model: 'model-a' },
        translationAiEnabled: true,
        translationMethod: 'ai',
        translationModel: { providerId: provider.id, model: 'model-a' },
      },
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toHaveValue('microsoft')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    const saved = await desktop.loadSettings()
    expect(saved.translation.aiEnabled).toBe(false)
    expect(saved.translation.method).toBe('microsoft')
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    expect(screen.getByRole('combobox', { name: '文本翻译 AI 模型' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('combobox', { name: '文本翻译 AI 模型' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: 'model-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    expect(screen.queryByRole('option', { name: 'AI 视觉 OCR' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'OCR 接口' })).toHaveValue('chaoxing')
    const footerSave = document.querySelector<HTMLButtonElement>('.settings-footer .primary-button')
    expect(footerSave).not.toBeNull()
    if (footerSave === null) throw new Error('settings save button missing')
    fireEvent.click(footerSave)
    await act(async () => Promise.resolve())
    const afterRemoval = await desktop.loadSettings()
    expect(afterRemoval.screenshotTranslation.ocrModel).toBeNull()
    expect(afterRemoval.screenshotTranslation.translationModel).toBeNull()
    expect(afterRemoval.screenshotTranslation.ocrMethod).toBe('chaoxing')
    expect(afterRemoval.screenshotTranslation.translationMethod).toBe('microsoft')
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
    expect(screen.queryByRole('button', { name: 'model-a' })).not.toBeInTheDocument()
    expect(screen.queryByText('获取到 1 个模型')).not.toBeInTheDocument()
  })

  it('keeps a current model fetch result when its own provider update replaces the draft', async () => {
    const desktop = new DeferredProviderDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'current-model-fetch',
        name: 'Current provider',
        baseUrl: 'https://current.example.com/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))

    await act(async () => {
      desktop.resolveModels?.(['current-model'])
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'current-model' })).toBeVisible()
    expect(screen.getByText('获取到 1 个模型')).toBeVisible()
  })

  it('does not apply a model fetch that finishes after provider changes are cancelled', async () => {
    const desktop = new DeferredProviderDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'cancelled-model-fetch',
        name: 'Saved provider',
        baseUrl: 'https://saved.example.com/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.change(screen.getByRole('textbox', { name: '提供商名称' }), {
      target: { value: 'Unsaved provider' },
    })
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('textbox', { name: '提供商名称' })).toHaveValue('Saved provider')

    await act(async () => {
      desktop.resolveModels?.(['stale-model'])
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: 'stale-model' })).not.toBeInTheDocument()
    expect(screen.queryByText('获取到 1 个模型')).not.toBeInTheDocument()
  })

  it('does not show a connection result that finishes after provider changes are cancelled', async () => {
    const desktop = new DeferredProviderDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'cancelled-connection-test',
        name: 'Saved provider',
        baseUrl: 'https://saved.example.com/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    const keys = screen.getByRole('textbox', { name: 'Saved provider API Keys' })
    fireEvent.change(keys, {
      target: { value: 'unsaved-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: '模型列表连接检查' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(keys).toHaveValue('')

    await act(async () => {
      desktop.resolveConnection?.({ success: true, error: null })
      await Promise.resolve()
    })

    expect(screen.queryByText('连接成功')).not.toBeInTheDocument()
  })

  it('keeps the raw multiline key draft and invalidates stale connection status', async () => {
    const desktop = new DeferredProviderDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const keys = screen.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
    fireEvent.change(keys, { target: { value: 'first-key\n' } })
    expect(keys).toHaveValue('first-key\n')
    fireEvent.change(keys, { target: { value: 'first-key\nsecond-key' } })
    expect(keys).toHaveValue('first-key\nsecond-key')

    fireEvent.click(screen.getByRole('button', { name: '模型列表连接检查' }))
    fireEvent.change(screen.getByRole('textbox', { name: '提供商 Base URL' }), {
      target: { value: 'https://changed.example/v1' },
    })
    await act(async () => {
      desktop.resolveConnection?.({ success: true, error: null })
      await Promise.resolve()
    })
    expect(screen.queryByText('连接成功')).not.toBeInTheDocument()
  })

  it('passes the current draft URL and plaintext keys to model fetch and connection test', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const url = screen.getByRole('textbox', { name: '提供商 Base URL' })
    const keys = screen.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
    fireEvent.change(url, { target: { value: 'https://draft.example/v1/responses' } })
    fireEvent.change(keys, { target: { value: ' draft-primary \n draft-backup ' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '模型列表连接检查' }))
      await Promise.resolve()
    })
    expect(desktop.providerModelFetchCalls).toHaveLength(1)
    expect(desktop.providerModelFetchCalls[0]?.provider.baseUrl).toBe('https://draft.example/v1/responses')
    expect(desktop.providerModelFetchCalls[0]?.keys).toEqual(['draft-primary'])
    expect(desktop.providerTestCalls).toHaveLength(1)
    expect(desktop.providerTestCalls[0]?.provider.baseUrl).toBe('https://draft.example/v1/responses')
    expect(desktop.providerTestCalls[0]?.keys).toEqual(['draft-primary'])
    const toast = screen.getByRole('status', { name: '连接成功' })
    expect(toast.parentElement).toBe(document.querySelector('.settings-window'))
    expect(toast.querySelector('.save-success-toast')).toHaveTextContent('连接成功')
    expect(document.querySelector('.provider-form .inline-status')).not.toHaveTextContent('连接成功')
  })

  it('uses the persisted provider key when the API Keys field is untouched', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'saved-provider',
        name: 'Saved Provider',
        baseUrl: 'https://saved.example/v1',
        keyCount: 1,
        availableModels: [],
        enabledModels: [],
      }],
    })
    await desktop.setProviderKeys('saved-provider', ['persisted-primary'])
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '模型列表连接检查' }))
      await Promise.resolve()
    })
    expect(desktop.providerModelFetchCalls).toHaveLength(1)
    expect(desktop.providerModelFetchCalls[0]?.provider.id).toBe('saved-provider')
    expect(desktop.providerModelFetchCalls[0]?.keys).toBeUndefined()
    expect(desktop.providerTestCalls).toHaveLength(1)
    expect(desktop.providerTestCalls[0]?.provider.id).toBe('saved-provider')
    expect(desktop.providerTestCalls[0]?.keys).toBeUndefined()
    expect(screen.getByText('连接成功')).toBeVisible()
  })

  it('does not reuse a persisted key after the draft field is explicitly cleared', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'cleared-provider',
        name: 'Cleared Provider',
        baseUrl: 'https://cleared.example/v1',
        keyCount: 1,
        availableModels: [],
        enabledModels: [],
      }],
    })
    await desktop.setProviderKeys('cleared-provider', ['persisted-primary'])
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    const keys = screen.getByRole('textbox', { name: 'Cleared Provider API Keys' })
    fireEvent.change(keys, { target: { value: 'draft-primary' } })
    fireEvent.change(keys, { target: { value: '' } })
    await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '模型列表连接检查' }))
      await Promise.resolve()
    })
    expect(desktop.providerTestCalls[0]?.provider.id).toBe('cleared-provider')
    expect(desktop.providerTestCalls[0]?.keys).toEqual([])
    const status = screen.getByText('Provider URL and primary key are required')
    expect(status).toBeVisible()
    expect(status).not.toHaveTextContent('persisted-primary')
    expect(status.closest('.save-success-toast-region')).toHaveAttribute('role', 'alert')
    expect(document.querySelector('.provider-form .inline-status')).not.toBeInTheDocument()
  })

  it('uses an entered key instead of a persisted provider key', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'override-provider',
        name: 'Override Provider',
        baseUrl: 'https://override.example/v1',
        keyCount: 1,
        availableModels: [],
        enabledModels: [],
      }],
    })
    await desktop.setProviderKeys('override-provider', ['persisted-primary'])
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Override Provider API Keys' }), {
      target: { value: 'draft-primary' },
    })
    await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '模型列表连接检查' }))
      await Promise.resolve()
    })
    expect(desktop.providerTestCalls[0]?.provider.id).toBe('override-provider')
    expect(desktop.providerTestCalls[0]?.keys).toEqual(['draft-primary'])
    expect(screen.getByText('连接成功')).toBeVisible()
  })

  it('keeps adapter credential drafts while switching settings sections', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    const apiKey = screen.getByLabelText('百度 OCR API Key')
    fireEvent.change(apiKey, { target: { value: 'draft-ocr-api' } })
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('draft-ocr-api')
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
    expect(desktop.adapterKeySaveCalls).toHaveLength(0)
  })

  it('cancels adapter credential drafts without writing them', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'cancel-api' } })
    fireEvent.change(screen.getByLabelText('百度 OCR Secret Key'), { target: { value: 'cancel-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('')
    expect(screen.getByLabelText('百度 OCR Secret Key')).toHaveValue('')
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(desktop.adapterKeySaveCalls).toHaveLength(0)
  })

  it('protects adapter credential drafts on close and keeps them after continuing', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'close-api' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })
    expect(dialog).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('close-api')
    expect(desktop.hides).toBe(0)
  })

  it('validates incomplete adapter drafts before starting a credential batch', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'only-api' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请完整填写凭据后再保存')
    expect(desktop.adapterKeySaveCalls).toHaveLength(0)
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('only-api')
  })

  it('keeps adapter credential input and retryability when the batch save fails', async () => {
    const desktop = new ClosingDesktop()
    desktop.adapterKeySaveError = 'adapter credential store unavailable: retry-adapter-secret'
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'retry-adapter-api' } })
    fireEvent.change(screen.getByLabelText('百度 OCR Secret Key'), { target: { value: 'retry-adapter-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    const failure = screen.getByRole('alert')
    expect(failure).toHaveTextContent('凭据保存失败')
    expect(failure).not.toHaveTextContent('retry-adapter-secret')
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('retry-adapter-api')
    expect(screen.getByLabelText('百度 OCR Secret Key')).toHaveValue('retry-adapter-secret')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('clears adapter plaintext after success and only changes the selected adapter', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveAdapterKeyChanges({
      'adapter-tencent-translation': ['existing-id', 'existing-secret'],
    })
    desktop.adapterKeySaveCalls.length = 0
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.change(screen.getByLabelText('百度 OCR API Key'), { target: { value: 'new-baidu-api' } })
    fireEvent.change(screen.getByLabelText('百度 OCR Secret Key'), { target: { value: 'new-baidu-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    expect(desktop.adapterKeySaveCalls).toEqual([{
      'adapter-baidu-ocr': ['new-baidu-api', 'new-baidu-secret'],
    }])
    expect(screen.getByLabelText('百度 OCR API Key')).toHaveValue('')
    expect(screen.getByLabelText('百度 OCR Secret Key')).toHaveValue('')
    expect(document.querySelector('[data-screenpilot-credential-state="adapter-baidu-ocr"]')).toHaveTextContent('已安全保存 2 个密钥')
    expect(await desktop.providerKeyCount('adapter-baidu-ocr')).toBe(2)
    expect(await desktop.providerKeyCount('adapter-tencent-translation')).toBe(2)
    expect(JSON.stringify(await desktop.loadSettings())).not.toContain('new-baidu-secret')
  })

  it('saves adapter clears as drafts and does not clear untouched adapters', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveAdapterKeyChanges({
      'adapter-baidu-ocr': ['old-api', 'old-secret'],
      'adapter-caiyun-translation': ['untouched-token'],
    })
    desktop.adapterKeySaveCalls.length = 0
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'OCR' }))
    fireEvent.click(screen.getByRole('button', { name: '清除凭据：百度 OCR' }))
    expect(screen.getByText('清除待保存')).toBeVisible()
    expect(desktop.adapterKeySaveCalls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    expect(desktop.adapterKeySaveCalls).toEqual([{ 'adapter-baidu-ocr': [] }])
    expect(await desktop.providerKeyCount('adapter-baidu-ocr')).toBe(0)
    expect(await desktop.providerKeyCount('adapter-caiyun-translation')).toBe(1)
    expect(document.querySelector('[data-screenpilot-credential-state="adapter-baidu-ocr"]')).toHaveTextContent('尚未配置')
  })

  it('links an adapter translation choice to the shared credential editor', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译' }))
    fireEvent.change(screen.getByRole('combobox', { name: '翻译接口' }), { target: { value: 'baidu' } })
    fireEvent.click(screen.getByRole('button', { name: '配置接口凭据' }))
    expect(screen.getByRole('heading', { name: 'OCR' })).toBeVisible()
    expect(screen.getByLabelText('百度翻译 App ID')).toBeVisible()
  })

  it('saves multiple provider key drafts only through the global save action', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [
        {
          id: 'provider-one',
          name: 'Provider One',
          baseUrl: 'https://one.example/v1',
          keyCount: 0,
          availableModels: [],
          enabledModels: [],
        },
        {
          id: 'provider-two',
          name: 'Provider Two',
          baseUrl: 'https://two.example/v1',
          keyCount: 0,
          availableModels: [],
          enabledModels: [],
        },
      ],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    expect(screen.queryByRole('button', { name: /保存密钥|保存秘钥/u })).not.toBeInTheDocument()
    const firstKeys = screen.getByRole('textbox', { name: 'Provider One API Keys' })
    const secondKeys = screen.getByRole('textbox', { name: 'Provider Two API Keys' })
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.change(firstKeys, { target: { value: 'one-secret\none-second' } })
    fireEvent.change(secondKeys, { target: { value: 'two-secret' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await act(async () => Promise.resolve())
    expect(desktop.providerKeySaveCalls).toEqual([{
      'provider-one': ['one-secret', 'one-second'],
      'provider-two': ['two-secret'],
    }])
    expect((await desktop.loadSettings()).providers.map((provider) => provider.keyCount)).toEqual([2, 1])
    expect(JSON.stringify(await desktop.loadSettings())).not.toContain('one-secret')
    expect(JSON.stringify(await desktop.loadSettings())).not.toContain('two-secret')
    expect(screen.getByText('所有更改已保存')).toBeVisible()
    expect(firstKeys).toHaveValue('')
    expect(secondKeys).toHaveValue('')
  })

  it('cancels provider key drafts without writing credentials', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'provider-cancel',
        name: 'Cancel Provider',
        baseUrl: 'https://cancel.example/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    const keys = screen.getByRole('textbox', { name: 'Cancel Provider API Keys' })
    const cancel = screen.getByRole('button', { name: '取消' })
    fireEvent.change(keys, { target: { value: 'cancel-secret' } })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    expect(keys).toHaveValue('')
    expect(cancel).toBeDisabled()
    expect(desktop.providerKeySaveCalls).toHaveLength(0)
  })

  it('keeps provider key drafts dirty and retryable when credential saving fails', async () => {
    const desktop = new ClosingDesktop()
    desktop.providerKeySaveError = 'credential store unavailable: retry-secret'
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'provider-failure',
        name: 'Failure Provider',
        baseUrl: 'https://failure.example/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    const keys = screen.getByRole('textbox', { name: 'Failure Provider API Keys' })
    const save = screen.getByRole('button', { name: '保存' })
    fireEvent.change(keys, { target: { value: 'retry-secret' } })
    fireEvent.click(save)
    await act(async () => Promise.resolve())
    const status = screen.getByText(/保存失败：凭据保存失败/u)
    expect(status).toBeVisible()
    expect(status).toHaveClass('validation-banner')
    expect(status).toHaveAttribute('role', 'alert')
    expect(status).not.toHaveTextContent('retry-secret')
    expect(screen.queryByText('设置已保存并立即生效')).not.toBeInTheDocument()
    expect(keys).toHaveValue('retry-secret')
    expect(save).toBeEnabled()
    expect(desktop.providerKeySaveCalls).toHaveLength(1)
    expect((await desktop.loadSettings()).providers[0]?.keyCount).toBe(0)
  })

  it('announces settings persistence failures as errors', async () => {
    const desktop = new FailingSaveDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('保存失败：Error: synthetic save failure')
    expect(failure).toHaveClass('validation-banner')
  })

  it('clears a removed provider key draft without writing credentials', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const keys = screen.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
    fireEvent.change(keys, { target: { value: 'temporary-secret' } })
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '删除 OpenAI Compatible' }))
    expect(screen.queryByRole('textbox', { name: 'OpenAI Compatible API Keys' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => Promise.resolve())
    expect(desktop.providerKeySaveCalls).toHaveLength(0)
  })

  it('uses the latest successful provider key save as the next cancel baseline', async () => {
    const desktop = new ClosingDesktop()
    await desktop.saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      providers: [{
        id: 'provider-baseline',
        name: 'Baseline Provider',
        baseUrl: 'https://baseline.example/v1',
        keyCount: 0,
        availableModels: [],
        enabledModels: [],
      }],
    })
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    const keys = screen.getByRole('textbox', { name: 'Baseline Provider API Keys' })
    const save = screen.getByRole('button', { name: '保存' })
    const cancel = screen.getByRole('button', { name: '取消' })
    fireEvent.change(keys, { target: { value: 'first-secret' } })
    fireEvent.click(save)
    await act(async () => Promise.resolve())
    fireEvent.change(keys, { target: { value: 'second-secret' } })
    fireEvent.click(save)
    await act(async () => Promise.resolve())
    expect(desktop.providerKeySaveCalls).toEqual([
      { 'provider-baseline': ['first-secret'] },
      { 'provider-baseline': ['second-secret'] },
    ])
    fireEvent.change(keys, { target: { value: 'discarded-secret' } })
    fireEvent.click(cancel)
    expect(keys).toHaveValue('')
    expect(cancel).toBeDisabled()
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

  it('only shows the administrator identity option under enabled startup', async () => {
    const startupSettings = structuredClone(DEFAULT_SETTINGS)
    startupSettings.general.launchAtStartupAsAdministrator = true
    const desktop = new StartupSettingsDesktop(startupSettings)
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await screen.findByRole('heading', { name: '外观与语言' })

    expect(screen.queryByRole('switch', { name: '管理员身份' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '开机启动' }))
    const administratorToggle = screen.getByRole('switch', { name: '管理员身份' })
    expect(administratorToggle).toBeInTheDocument()
    expect(administratorToggle).toHaveAttribute('aria-checked', 'true')
    expect(administratorToggle.closest('.setting-row')).toHaveClass('setting-row--nested')

    fireEvent.click(administratorToggle)
    expect(administratorToggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('switch', { name: '开机启动' }))
    expect(screen.queryByRole('switch', { name: '管理员身份' })).not.toBeInTheDocument()
  })
})
