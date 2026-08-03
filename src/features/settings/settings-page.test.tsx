import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { DEFAULT_SETTINGS } from './defaults'
import type { AppSettings, ProviderSettings, SettingsExport } from './types'
import type { SettingsSaveResult } from '../../desktop/contract'
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

class CountingSettingsDesktop extends ClosingDesktop {
  saves = 0

  override saveSettings(settings: AppSettings): Promise<SettingsSaveResult> {
    this.saves += 1
    return super.saveSettings(settings)
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

class ImportSettingsDesktop extends CountingSettingsDesktop {
  constructor(private readonly importedSettings: AppSettings) {
    super()
  }

  override importSettings(): Promise<SettingsExport> {
    return Promise.resolve({
      type: 'screenpilot-settings-export',
      schemaVersion: 1,
      appVersion: '0.1.0',
      exportedAt: '2026-08-02T00:00:00.000Z',
      includesSecrets: false,
      settings: structuredClone(this.importedSettings),
    })
  }
}

class DeferredProviderDesktop extends ClosingDesktop {
  resolveModels: ((models: string[]) => void) | null = null

  override fetchProviderModels(provider: ProviderSettings, keys?: string[]): Promise<string[]> {
    void provider
    void keys
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

  it('normalizes provider draft overrides to one primary key while preserving tri-state', () => {
    expect(primaryProviderKeyDraft(undefined)).toBeUndefined()
    expect(primaryProviderKeyDraft([])).toEqual([])
    expect(primaryProviderKeyDraft(['  ', ' draft-primary ', 'backup'])).toEqual(['draft-primary'])
  })

  it('offers save, discard and continue choices before closing dirty settings', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(await screen.findByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })
    expect(dialog).toHaveClass('decision-dialog', 'unsaved-close-dialog')
    expect(dialog.parentElement).toHaveClass('dialog-backdrop', 'unsaved-close-backdrop')
    expect(dialog).toHaveTextContent('保存并关闭')
    expect(dialog).toHaveTextContent('放弃更改')
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃更改' }))
    expect(desktop.hides).toBe(1)
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

  it('offers a default reset for every editable prompt field', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const fields = [
      { section: '翻译', label: '大模型翻译系统提示词', value: DEFAULT_SETTINGS.translation.prompt },
      { section: 'OCR', label: 'OCR 提示词', value: DEFAULT_SETTINGS.screenshotTranslation.ocrPrompt },
      { section: 'OCR', label: '截图翻译提示词', value: DEFAULT_SETTINGS.screenshotTranslation.translationPrompt },
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
    expect(screen.queryByRole('combobox', { name: '截图翻译模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'AI 视觉 OCR' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'AI' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型 OCR' }))
    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    const ocrModel = screen.getByRole('combobox', { name: 'OCR 模型' })
    const screenshotTranslationModel = screen.getByRole('combobox', { name: '截图翻译模型' })
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
    let screenshotGroup = activeGroup('截图翻译')
    let ocrToggleRow = rowFor(screenshotGroup, '开启大模型 OCR')
    let ocrInterfaceRow = rowFor(screenshotGroup, 'OCR 接口')
    let screenshotTranslationToggleRow = rowFor(screenshotGroup, '开启大模型翻译')
    let screenshotTranslationInterfaceRow = rowFor(screenshotGroup, '翻译接口')
    expect(ocrToggleRow.nextElementSibling).toBe(ocrInterfaceRow)
    expect(screenshotTranslationToggleRow.nextElementSibling).toBe(screenshotTranslationInterfaceRow)
    expect(screen.queryByRole('combobox', { name: 'OCR 模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '截图翻译模型' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '开启大模型 OCR' }))
    screenshotGroup = activeGroup('截图翻译')
    ocrToggleRow = rowFor(screenshotGroup, '开启大模型 OCR')
    ocrInterfaceRow = rowFor(screenshotGroup, 'OCR 接口')
    const ocrModelRow = screen.getByRole('combobox', { name: 'OCR 模型' }).closest<HTMLElement>('.setting-row')
    expect(ocrModelRow).not.toBeNull()
    expect(ocrToggleRow.nextElementSibling).toBe(ocrModelRow)
    expect(ocrModelRow?.nextElementSibling).toBe(ocrInterfaceRow)

    fireEvent.click(screen.getByRole('switch', { name: '开启大模型翻译' }))
    screenshotGroup = activeGroup('截图翻译')
    screenshotTranslationToggleRow = rowFor(screenshotGroup, '开启大模型翻译')
    screenshotTranslationInterfaceRow = rowFor(screenshotGroup, '翻译接口')
    const screenshotTranslationModelRow = screen
      .getByRole('combobox', { name: '截图翻译模型' })
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
    expect(screen.getByRole('button', { name: 'model-a' })).toBeVisible()
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
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
      await Promise.resolve()
    })
    expect(desktop.providerModelFetchCalls).toHaveLength(1)
    expect(desktop.providerModelFetchCalls[0]?.provider.baseUrl).toBe('https://draft.example/v1/responses')
    expect(desktop.providerModelFetchCalls[0]?.keys).toEqual(['draft-primary'])
    expect(desktop.providerTestCalls).toHaveLength(1)
    expect(desktop.providerTestCalls[0]?.provider.baseUrl).toBe('https://draft.example/v1/responses')
    expect(desktop.providerTestCalls[0]?.keys).toEqual(['draft-primary'])
    expect(screen.getByText('连接成功')).toBeVisible()
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
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
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
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
      await Promise.resolve()
    })
    expect(desktop.providerTestCalls[0]?.provider.id).toBe('cleared-provider')
    expect(desktop.providerTestCalls[0]?.keys).toEqual([])
    const status = screen.getByText('Provider URL and primary key are required')
    expect(status).toBeVisible()
    expect(status).not.toHaveTextContent('persisted-primary')
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
      fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
      await Promise.resolve()
    })
    expect(desktop.providerTestCalls[0]?.provider.id).toBe('override-provider')
    expect(desktop.providerTestCalls[0]?.keys).toEqual(['draft-primary'])
    expect(screen.getByText('连接成功')).toBeVisible()
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
    expect(status).not.toHaveTextContent('retry-secret')
    expect(screen.queryByText('设置已保存并立即生效')).not.toBeInTheDocument()
    expect(keys).toHaveValue('retry-secret')
    expect(save).toBeEnabled()
    expect(desktop.providerKeySaveCalls).toHaveLength(1)
    expect((await desktop.loadSettings()).providers[0]?.keyCount).toBe(0)
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
})
