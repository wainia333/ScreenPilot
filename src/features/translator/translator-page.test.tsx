import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import type {
  TranslationRequest,
  TranslationResult,
  TranslationSettingsPatch,
  Unlisten,
} from '../../desktop/contract'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { TRANSLATOR_INPUT_DEBOUNCE_MS, TranslatorPage } from './translator-page'

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function getHistoryRestore(dialog: HTMLElement): HTMLElement {
  const restore = dialog.querySelector<HTMLElement>('.history-menu-restore')
  if (restore === null) throw new Error('History restore control is missing')
  return restore
}

class RecordingDesktop extends FakeDesktopPort {
  readonly translations: TranslationRequest[] = []
  readonly commits: string[] = []
  readonly commitAutoPaste: boolean[] = []
  hides = 0
  drags = 0
  rejectNextDrag = false
  dragFailureHandled = false
  selection = ''

  override translate(request: TranslationRequest): Promise<TranslationResult> {
    this.translations.push(request)
    return Promise.resolve({ generation: request.generation, text: `translated:${request.text}` })
  }

  override commitText(text: string, autoPaste: boolean): Promise<void> {
    this.commits.push(text)
    this.commitAutoPaste.push(autoPaste)
    return Promise.resolve()
  }

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

  override takeTranslatorSelection(): Promise<string> {
    return Promise.resolve(this.selection)
  }
}

class DeferredTranslationDesktop extends RecordingDesktop {
  readonly pending: { request: TranslationRequest; resolve: (result: TranslationResult) => void }[] = []

  override translate(request: TranslationRequest): Promise<TranslationResult> {
    this.translations.push(request)
    return new Promise((resolve) => {
      this.pending.push({ request, resolve })
    })
  }
}

class RetryTranslationDesktop extends RecordingDesktop {
  failures = 1

  override translate(request: TranslationRequest): Promise<TranslationResult> {
    this.translations.push(request)
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error('synthetic network timeout'))
    }
    return Promise.resolve({ generation: request.generation, text: `translated:${request.text}` })
  }
}

class ReloadSettingsDesktop extends RecordingDesktop {
  loadCalls = 0
  failures = 1

  override loadSettings(): ReturnType<FakeDesktopPort['loadSettings']> {
    this.loadCalls += 1
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error('synthetic settings unavailable'))
    }
    return super.loadSettings()
  }
}

class RejectingTranslatorDesktop extends RecordingDesktop {
  rejectCommit = false
  rejectHide = false

  override commitText(text: string, autoPaste: boolean): Promise<void> {
    this.commits.push(text)
    this.commitAutoPaste.push(autoPaste)
    if (this.rejectCommit) return Promise.reject(new Error('synthetic commit failure'))
    return Promise.resolve()
  }

  override hideWindow(): Promise<void> {
    this.hides += 1
    if (this.rejectHide) return Promise.reject(new Error('synthetic hide failure'))
    return Promise.resolve()
  }

}

class DeferredSettingsDesktop extends RecordingDesktop {
  readonly settingsUpdates: {
    patch: TranslationSettingsPatch
    resolve: () => void
    reject: (reason: unknown) => void
  }[] = []

  override updateTranslationSettings(patch: TranslationSettingsPatch): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settingsUpdates.push({
        patch: structuredClone(patch),
        resolve: () => {
          void super.updateTranslationSettings(patch).then(resolve, reject)
        },
        reject,
      })
    })
  }
}

class RecoveringListenerDesktop extends RecordingDesktop {
  prepareAttempts = 0
  selectionAttempts = 0
  prepareFailures = 0
  selectionFailures = 0
  prepareUnlistens = 0
  selectionUnlistens = 0

  override onTranslatorPrepare(listener: () => void): Promise<Unlisten> {
    this.prepareAttempts += 1
    if (this.prepareFailures > 0) {
      this.prepareFailures -= 1
      return Promise.reject(new Error('synthetic prepare listener failure'))
    }
    return super.onTranslatorPrepare(listener).then((unlisten) => () => {
      this.prepareUnlistens += 1
      unlisten()
    })
  }

  override onTranslatorSelection(listener: (selection: string) => void): Promise<Unlisten> {
    this.selectionAttempts += 1
    if (this.selectionFailures > 0) {
      this.selectionFailures -= 1
      return Promise.reject(new Error('synthetic selection listener failure'))
    }
    return super.onTranslatorSelection(listener).then((unlisten) => () => {
      this.selectionUnlistens += 1
      unlisten()
    })
  }
}

class DeferredPrepareListenerDesktop extends RecoveringListenerDesktop {
  resolvePrepare: ((unlisten: Unlisten) => void) | null = null

  override onTranslatorPrepare(): Promise<Unlisten> {
    this.prepareAttempts += 1
    return new Promise((resolve) => {
      this.resolvePrepare = resolve
    })
  }
}

class DeferredSelectionListenerDesktop extends RecordingDesktop {
  selectionReads = 0
  resolveSelectionListener: (() => void) | null = null

  override onTranslatorSelection(): Promise<Unlisten> {
    return new Promise((resolve) => {
      this.resolveSelectionListener = () => resolve(() => undefined)
    })
  }

  override takeTranslatorSelection(): Promise<string> {
    this.selectionReads += 1
    return super.takeTranslatorSelection()
  }
}

describe('TranslatorPage', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    sessionStorage.clear()
    localStorage.clear()
  })

  it('actively cancels stale work for input, settings, history restore, and unmount', async () => {
    vi.useFakeTimers()
    localStorage.setItem('screenpilot:translator-history', JSON.stringify([{
      id: 'saved-translation',
      input: 'saved source',
      output: 'saved result',
      method: 'microsoft',
      updatedAt: Date.now(),
    }]))
    const desktop = new RecordingDesktop()
    const view = render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const afterMount = desktop.translationCancelCalls.length

    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'new source' } })
    expect(desktop.translationCancelCalls.length).toBe(afterMount + 1)
    fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), { target: { value: 'ja' } })
    expect(desktop.translationCancelCalls.length).toBe(afterMount + 2)

    fireEvent.click(screen.getByRole('button', { name: '翻译历史' }))
    const restore = screen.getByRole('dialog', { name: '翻译历史' }).querySelector<HTMLButtonElement>('.history-menu-restore')
    expect(restore).not.toBeNull()
    if (restore === null) throw new Error('History restore control is missing')
    fireEvent.click(restore)
    expect(desktop.translationCancelCalls.length).toBe(afterMount + 3)

    const beforeUnmount = desktop.translationCancelCalls.length
    view.unmount()
    expect(desktop.translationCancelCalls.length).toBe(beforeUnmount + 1)
    expect(desktop.translationCancelCalls.every(Number.isSafeInteger)).toBe(true)
  })

  it('uses a higher generation after a same-millisecond remount', async () => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const desktop = new RecordingDesktop()
    desktop.selection = 'first mount source'
    const firstView = render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    const firstGeneration = desktop.translations.at(-1)?.generation
    expect(firstGeneration).toBeDefined()
    firstView.unmount()
    const unmountCancellation = desktop.translationCancelCalls.at(-1)

    desktop.selection = 'second mount source'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    const secondGeneration = desktop.translations.at(-1)?.generation

    expect(unmountCancellation).toBeGreaterThan(firstGeneration ?? 0)
    expect(secondGeneration).toBeGreaterThan(unmountCancellation ?? 0)
    expect(Number.isSafeInteger(secondGeneration)).toBe(true)
  })

  it('loads the saved English interface language for the standalone window', async () => {
    const desktop = new RecordingDesktop()
    await desktop.saveSettings({ ...(await desktop.loadSettings()), language: 'en' })
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)

    expect(await screen.findByRole('heading', { name: 'Text Translation' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Original' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Translation service' })).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute('lang', 'en')
  })

  it('waits 1500ms, ignores IME submit and commits after composition ends', async () => {
    vi.useFakeTimers()
    expect(TRANSLATOR_INPUT_DEBOUNCE_MS).toBe(1500)
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'sample' } })
    await act(() => vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS - 1))
    expect(desktop.translations).toHaveLength(0)
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(desktop.translations).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('translated:sample')
    fireEvent.change(screen.getByRole('textbox', { name: '译文' }), { target: { value: 'edited translation' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(desktop.commits).toHaveLength(0)
    fireEvent.compositionEnd(input)
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })
    expect(desktop.commits).toEqual(['edited translation'])
  })

  it('offers a localized retry after the first translation failure without changing input', async () => {
    vi.useFakeTimers()
    const desktop = new RetryTranslationDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'retry source' } })

    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(desktop.translations).toHaveLength(1)
    expect(input).toHaveValue('retry source')
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接失败')
    expect(screen.getByRole('alert')).toHaveTextContent('synthetic network timeout')
    expect(screen.getByText('技术详情')).toBeInTheDocument()

    const retry = screen.getByRole('button', { name: '重试翻译' })
    await act(async () => {
      fireEvent.click(retry)
      fireEvent.click(retry)
      await Promise.resolve()
    })

    expect(desktop.translations).toHaveLength(2)
    expect(input).toHaveValue('retry source')
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('translated:retry source')
  })

  it('keeps input unchanged and exposes an explicit settings reload after the first load fails', async () => {
    vi.useFakeTimers()
    const desktop = new ReloadSettingsDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'typed before settings recovery' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.translations).toHaveLength(0)
    expect(screen.getByRole('button', { name: '重新加载设置' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toBeDisabled()

    desktop.failures = 0
    const reload = screen.getByRole('button', { name: '重新加载设置' })
    await act(async () => {
      fireEvent.click(reload)
      fireEvent.click(reload)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(desktop.loadCalls).toBe(2)
    expect(input).toHaveValue('typed before settings recovery')
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toBeEnabled()
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.translations).toHaveLength(1)
    expect(desktop.translations[0]).toMatchObject({ text: 'typed before settings recovery' })
  })

  it('injects the hotkey selection and translates it without manual editing', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    desktop.selection = 'selected source'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByLabelText('原文')).toHaveValue('selected source')
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)?.text).toBe('selected source')
  })

  it('accepts a delayed hotkey selection after the window is already mounted', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByLabelText('原文')).toHaveValue('')
    await act(async () => {
      desktop.emitTranslatorPrepare()
      await Promise.resolve()
    })
    expect(screen.getByLabelText('原文')).toHaveValue('')
    await act(async () => {
      desktop.emitTranslatorSelection('delayed selection')
      await Promise.resolve()
    })
    expect(screen.getByLabelText('原文')).toHaveValue('delayed selection')
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)?.text).toBe('delayed selection')
  })

  it('preserves typing in the revealed window when capture finishes later', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    await act(async () => {
      desktop.emitTranslatorPrepare()
      await Promise.resolve()
    })
    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'typed while capture was pending' } })

    await act(async () => {
      desktop.selection = 'late selection'
      desktop.emitTranslatorSelection(desktop.selection)
      fireEvent.focus(window)
      await Promise.resolve()
    })
    expect(input).toHaveValue('typed while capture was pending')

    await act(async () => {
      desktop.emitTranslatorPrepare()
      desktop.emitTranslatorSelection('next hotkey selection')
      await Promise.resolve()
    })
    expect(screen.getByLabelText('原文')).toHaveValue('next hotkey selection')
  })

  it('starts a new translation when consecutive selection events contain the same text', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    await act(async () => {
      desktop.emitTranslatorSelection('repeated selection')
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    const firstGeneration = desktop.translations.at(-1)?.generation
    expect(desktop.translations.map((request) => request.text)).toEqual(['repeated selection'])

    await act(async () => {
      desktop.emitTranslatorSelection('repeated selection')
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })

    expect(desktop.translations.map((request) => request.text)).toEqual([
      'repeated selection',
      'repeated selection',
    ])
    expect(desktop.translations.at(-1)?.generation).toBeGreaterThan(firstGeneration ?? 0)
  })

  it('coalesces a stored snapshot with the matching selection event', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    desktop.selection = 'single captured selection'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    await act(async () => {
      desktop.emitTranslatorSelection('single captured selection')
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })

    expect(desktop.translations.map((request) => request.text)).toEqual([
      'single captured selection',
    ])
  })

  it('returns to the manual-input debounce when a hotkey selection is edited immediately', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    await act(async () => {
      desktop.emitTranslatorSelection('hotkey selection')
      await Promise.resolve()
    })
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'manual replacement' } })
    await act(() => vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS - 1))
    expect(desktop.translations).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(desktop.translations.map((request) => request.text)).toEqual(['manual replacement'])
  })

  it('subscribes before reading the stored selection during a cold start', async () => {
    const desktop = new DeferredSelectionListenerDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    expect(desktop.selectionReads).toBe(0)
    desktop.selection = 'captured after OCR'
    await act(async () => {
      desktop.resolveSelectionListener?.()
      await Promise.resolve()
    })

    expect(desktop.selectionReads).toBe(1)
    expect(screen.getByLabelText('原文')).toHaveValue('captured after OCR')
  })

  it('skips the cold-start snapshot when the user has already typed', async () => {
    const desktop = new DeferredSelectionListenerDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'manual input' } })
    desktop.selection = 'stale captured text'
    await act(async () => {
      desktop.resolveSelectionListener?.()
      await Promise.resolve()
    })

    expect(desktop.selectionReads).toBe(0)
    expect(screen.getByLabelText('原文')).toHaveValue('manual input')
  })

  it('reloads the latest settings before translating a reused F2 window', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const latest = await desktop.loadSettings()
    await desktop.saveSettings({
      ...latest,
      general: { ...latest.general, autoPaste: false },
      translation: {
        ...latest.translation,
        method: 'google',
        sourceLanguage: 'en',
        targetLanguage: 'ja',
      },
    })

    await act(async () => {
      desktop.emitTranslatorPrepare()
      desktop.emitTranslatorSelection('reused selection')
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })

    expect(desktop.translations.at(-1)).toMatchObject({
      text: 'reused selection',
      method: 'google',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('原文'), { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })
    expect(desktop.commits).toEqual(['translated:reused selection'])
    expect(desktop.commitAutoPaste).toEqual([false])
  })

  it('does not restore an old captured selection when the edited window regains focus', async () => {
    const desktop = new RecordingDesktop()
    desktop.selection = 'captured source'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')
    expect(input).toHaveValue('captured source')

    fireEvent.change(input, { target: { value: 'user edited source' } })
    await act(async () => {
      fireEvent.focus(window)
      await Promise.resolve()
    })
    expect(input).toHaveValue('user edited source')

    desktop.selection = 'new captured source'
    await act(async () => {
      fireEvent.focus(window)
      await Promise.resolve()
    })
    expect(input).toHaveValue('new captured source')
  })

  it('offers the OCR target languages and retranslates immediately after a change', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    desktop.selection = 'selected source'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const language = screen.getByRole('combobox', { name: '目标语言' })
    expect(screen.getByRole('combobox', { name: '源语言' })).toHaveClass('translator-language-select')
    expect(language).toHaveClass('translator-language-select')
    expect(language).toHaveValue('auto')
    expect(screen.getAllByRole('option', { name: '简体中文' })).toHaveLength(2)
    expect(screen.getAllByRole('option', { name: 'English' })).toHaveLength(2)
    fireEvent.change(language, { target: { value: 'ja' } })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)?.targetLanguage).toBe('ja')
  })

  it('ignores a late response after a newer debounced input', async () => {
    vi.useFakeTimers()
    const desktop = new DeferredTranslationDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'first source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.pending).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'latest source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.pending).toHaveLength(2)
    await act(async () => {
      desktop.pending[1]?.resolve({ generation: desktop.pending[1].request.generation, text: 'latest result' })
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('latest result')
    await act(async () => {
      desktop.pending[0]?.resolve({ generation: desktop.pending[0].request.generation, text: 'stale result' })
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('latest result')
  })

  it('keeps the previous translation visible through debounce and request latency', async () => {
    vi.useFakeTimers()
    const desktop = new DeferredTranslationDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')

    fireEvent.change(input, { target: { value: 'first source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.pending).toHaveLength(1)
    await act(async () => {
      desktop.pending[0]?.resolve({ generation: desktop.pending[0].request.generation, text: 'first result' })
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('first result')

    fireEvent.change(input, { target: { value: 'latest source' } })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('first result')
    await act(() => vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS - 1))
    expect(desktop.pending).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('first result')

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(desktop.pending).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('first result')
    await act(async () => {
      desktop.pending[1]?.resolve({ generation: desktop.pending[1].request.generation, text: 'latest result' })
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('latest result')
  })

  it('uses the latest source when committing during a pending retranslation', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'first source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('translated:first source')

    fireEvent.change(input, { target: { value: 'latest source' } })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('translated:first source')
    expect(screen.getByRole('button', { name: '复制译文' })).toBeDisabled()
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })
    expect(desktop.commits).toEqual(['latest source'])
    expect(desktop.commits).not.toContain('translated:first source')
  })

  it('invalidates a translated result as soon as translation settings change', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    desktop.selection = 'source text'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('translated:source text')

    fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), { target: { value: 'ja' } })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '复制译文' })).toBeDisabled()
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('原文'), { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })
    expect(desktop.commits).toEqual(['source text'])
    expect(desktop.commits).not.toContain('translated:source text')
  })

  it('announces clipboard failures without an unhandled rejection and preserves copy success feedback', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    const writeText = vi.fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new DOMException('synthetic clipboard denial', 'NotAllowedError'))
      .mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'copy source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    const copy = screen.getByRole('button', { name: '复制译文' })

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenNthCalledWith(1, 'translated:copy source')
    expect(screen.getByText('复制失败，请检查剪贴板权限')).toHaveAttribute('aria-live', 'polite')
    expect(copy.querySelector('svg')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenNthCalledWith(2, 'translated:copy source')
    expect(screen.queryByText('复制失败，请检查剪贴板权限')).not.toBeInTheDocument()
    expect(copy.querySelector('.lucide-check')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTime(1200))
    expect(copy.querySelector('.lucide-clipboard')).toBeInTheDocument()
  })

  it('shows and synchronizes the translation history badge', async () => {
    localStorage.setItem('screenpilot:translator-history', JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
      id: `saved-translation-${String(index)}`,
      input: 'saved source',
      output: 'saved result',
      method: 'microsoft',
      updatedAt: index,
    }))))
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const historyButton = screen.getByRole('button', { name: '翻译历史' })
    expect(historyButton).toHaveClass('ocr-header-button', 'history-button')
    expect(historyButton).toHaveClass('history-button-count-2')
    expect(historyButton.querySelector('.history-count-badge')).toHaveTextContent('20')
    expect(screen.getByText('历史记录：20 条')).toBeInTheDocument()
    fireEvent.click(historyButton)
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(historyButton.querySelector('.history-count-badge')).toBeNull()
    expect(historyButton).not.toHaveClass('history-button-count-1', 'history-button-count-2')
    expect(screen.getByText('暂无历史记录')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'new source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(historyButton).toHaveClass('history-button-count-1')
    expect(historyButton).not.toHaveClass('history-button-count-2')
    expect(historyButton.querySelector('.history-count-badge')).toHaveTextContent('1')
  })

  it('matches the compact reference history menu and restores entries', async () => {
    localStorage.setItem('screenpilot:translator-history', JSON.stringify([{
      id: 'saved-translation',
      input: 'saved source',
      output: 'saved result',
      method: 'microsoft',
      updatedAt: Date.now(),
    }]))
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    const historyButton = screen.getByRole('button', { name: '翻译历史' })
    expect(historyButton).toHaveClass('ocr-header-button', 'history-button')
    expect(historyButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(historyButton)
    const menu = screen.getByRole('dialog', { name: '翻译历史' })
    expect(menu).toHaveClass('history-menu-popover')
    expect(menu.querySelector('.history-menu-list')).not.toBeNull()
    expect(menu.querySelector('.history-menu-input')).toHaveTextContent('saved source')
    expect(menu.querySelector('.history-menu-output')).toHaveTextContent('saved result')
    expect(menu.querySelector('.history-menu-meta')).toHaveTextContent(/Microsoft · 语言信息未知 · 刚刚/u)

    const restore = menu.querySelector<HTMLButtonElement>('.history-menu-restore')
    expect(restore).not.toBeNull()
    if (restore === null) throw new Error('History restore control is missing')
    fireEvent.click(restore)
    await act(async () => Promise.resolve())
    expect(screen.getByLabelText('原文')).toHaveValue('saved source')
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('saved result')
    expect(screen.queryByRole('dialog', { name: '翻译历史' })).toBeNull()

    fireEvent.keyDown(historyButton, { key: 'ArrowDown' })
    await act(async () => Promise.resolve())
    expect(screen.getByRole('dialog', { name: '翻译历史' }).querySelector('.history-menu-restore')).toBe(document.activeElement)
    fireEvent.keyDown(window, { key: 'Escape' })
    await act(async () => Promise.resolve())
    expect(screen.queryByRole('dialog', { name: '翻译历史' })).toBeNull()
    expect(document.activeElement).toBe(historyButton)
    expect(desktop.hides).toBe(0)
    fireEvent.click(historyButton)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: '翻译历史' })).toBeNull()

    fireEvent.click(historyButton)
    const reopenedMenu = screen.getByRole('dialog', { name: '翻译历史' })
    const clear = reopenedMenu.querySelector<HTMLButtonElement>('.history-menu-clear')
    expect(clear).not.toBeNull()
    if (clear === null) throw new Error('History clear control is missing')
    clear.focus()
    const source = screen.getByLabelText('原文')
    fireEvent.focusOut(clear, { relatedTarget: source })
    source.focus()
    expect(screen.queryByRole('dialog', { name: '翻译历史' })).toBeNull()
    expect(source).toHaveFocus()
  })

  it('migrates versioned history context without changing global settings or requesting on restore', async () => {
    vi.useFakeTimers()
    localStorage.setItem('screenpilot:translator-history', JSON.stringify([
      {
        id: 'baidu-history',
        input: '历史原文',
        output: '历史译文',
        schemaVersion: 1,
        sourceLanguage: 'en',
        targetLanguage: 'ja',
        method: 'baidu',
        model: null,
        updatedAt: Date.now(),
      },
      {
        id: 'microsoft-history',
        input: '另一条历史',
        output: '另一条译文',
        schemaVersion: 1,
        sourceLanguage: 'zh-CN',
        targetLanguage: 'en',
        method: 'microsoft',
        model: null,
        updatedAt: Date.now() - 1,
      },
    ]))
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    const historyButton = screen.getByRole('button', { name: '翻译历史' })
    expect(screen.getByRole('combobox', { name: '源语言' })).toHaveValue('auto')
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('auto')
    fireEvent.click(historyButton)
    const menu = screen.getByRole('dialog', { name: '翻译历史' })
    expect(menu.querySelector('.history-menu-meta')).toHaveTextContent(/百度 · (英语|English) → (日语|日本語)/u)
    const restore = menu.querySelector<HTMLButtonElement>('.history-menu-restore')
    expect(restore).not.toBeNull()
    if (restore === null) throw new Error('Versioned history restore control is missing')
    fireEvent.click(restore)
    await act(async () => Promise.resolve())
    expect(desktop.translations).toHaveLength(0)
    expect(screen.getByRole('combobox', { name: '源语言' })).toHaveValue('auto')
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('auto')
    expect(screen.getByRole('status')).toHaveTextContent(/历史参数[:：] 百度 · (英语|English) → (日语|日本語)/u)

    fireEvent.change(screen.getByLabelText('原文'), { target: { value: '明确重译' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)).toMatchObject({
      method: 'baidu',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
    })
    const saved = JSON.parse(localStorage.getItem('screenpilot:translator-history') ?? '[]') as Record<string, unknown>[]
    expect(saved[0]).toMatchObject({ schemaVersion: 1, sourceLanguage: 'en', targetLanguage: 'ja', method: 'baidu' })
  })

  it('flushes edited translation history before restore and unmount, keeps copy current, and reopens the edit', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { writes.push(text); return Promise.resolve() } },
    })
    localStorage.setItem('screenpilot:translator-history', JSON.stringify([{
      id: 'editable-translation',
      input: 'source to edit',
      output: 'model output',
      schemaVersion: 1,
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      method: 'microsoft',
      model: null,
      updatedAt: Date.now(),
    }]))
    const desktop = new RecordingDesktop()
    const view = render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const historyButton = screen.getByRole('button', { name: '翻译历史' })
    fireEvent.click(historyButton)
    fireEvent.click(getHistoryRestore(screen.getByRole('dialog', { name: '翻译历史' })))
    const output = screen.getByRole('textbox', { name: '译文' })
    fireEvent.change(output, { target: { value: 'edited output' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制译文' }))
      await Promise.resolve()
    })
    expect(writes).toEqual(['edited output'])
    fireEvent.click(historyButton)
    fireEvent.click(getHistoryRestore(screen.getByRole('dialog', { name: '翻译历史' })))
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('edited output')
    fireEvent.change(screen.getByRole('textbox', { name: '译文' }), { target: { value: 'edited again' } })
    view.unmount()
    expect(localStorage.getItem('screenpilot:translator-history')).toContain('edited again')
    expect(desktop.translations).toHaveLength(0)

    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译历史' }))
    fireEvent.click(getHistoryRestore(screen.getByRole('dialog', { name: '翻译历史' })))
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('edited again')
  })

  it('shows and retries a failed edited translation history save', async () => {
    localStorage.setItem('screenpilot:translator-history', JSON.stringify([{
      id: 'failed-translation-edit',
      input: 'source',
      output: 'before edit',
      schemaVersion: 1,
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      method: 'microsoft',
      model: null,
      updatedAt: Date.now(),
    }]))
    const desktop = new RecordingDesktop()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('synthetic quota', 'QuotaExceededError')
    })
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '翻译历史' }))
    fireEvent.click(getHistoryRestore(screen.getByRole('dialog', { name: '翻译历史' })))
    const output = screen.getByRole('textbox', { name: '译文' })
    fireEvent.change(output, { target: { value: 'failed edit' } })
    fireEvent.blur(output)
    await act(async () => Promise.resolve())
    expect(screen.getByRole('alert')).toHaveTextContent('当前会话可用，历史未保存')
    setItem.mockRestore()
    fireEvent.click(screen.getByRole('button', { name: '重试保存历史' }))
    await act(async () => Promise.resolve())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(localStorage.getItem('screenpilot:translator-history')).toContain('failed edit')
  })

  it('submits an explicit source language and retranslates immediately', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    desktop.selection = 'English source'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const language = screen.getByRole('combobox', { name: '源语言' })
    expect(language).toHaveValue('auto')
    fireEvent.change(language, { target: { value: 'en' } })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)?.sourceLanguage).toBe('en')
  })

  it('serializes rapid setting changes and persists the last intent', async () => {
    const desktop = new DeferredSettingsDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.change(screen.getByRole('combobox', { name: '源语言' }), {
      target: { value: 'en' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), {
      target: { value: 'ja' },
    })
    await act(async () => Promise.resolve())

    expect(desktop.settingsUpdates).toHaveLength(1)
    expect(desktop.settingsUpdates[0]?.patch).toEqual({ sourceLanguage: 'en' })
    await act(async () => {
      desktop.settingsUpdates[0]?.resolve()
      await Promise.resolve()
    })
    expect(desktop.settingsUpdates).toHaveLength(2)
    expect(desktop.settingsUpdates[1]?.patch).toEqual({ targetLanguage: 'ja' })
    await act(async () => {
      desktop.settingsUpdates[1]?.resolve()
      await Promise.resolve()
    })

    const saved = await desktop.loadSettings()
    expect(saved.translation.sourceLanguage).toBe('en')
    expect(saved.translation.targetLanguage).toBe('ja')
    expect(screen.getByRole('combobox', { name: '源语言' })).toHaveValue('en')
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('ja')
  })

  it('does not let a late settings refresh discard a pending last intent', async () => {
    const desktop = new DeferredSettingsDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), {
      target: { value: 'ko' },
    })
    await act(async () => {
      desktop.emitTranslatorPrepare()
      await Promise.resolve()
    })
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('ko')
    expect(desktop.settingsUpdates).toHaveLength(1)

    await act(async () => {
      desktop.settingsUpdates[0]?.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('ko')
    expect((await desktop.loadSettings()).translation.targetLanguage).toBe('ko')
  })

  it('rolls setting controls back to confirmed storage after a rejected update', async () => {
    const desktop = new DeferredSettingsDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), {
      target: { value: 'ja' },
    })
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('ja')
    await act(async () => {
      desktop.settingsUpdates[0]?.reject(new Error('synthetic settings update failure'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveValue('auto')
    expect(screen.getByRole('alert')).toHaveTextContent('设置保存失败，已恢复上次保存的选项')
    expect(screen.getByRole('alert')).toHaveTextContent('synthetic settings update failure')
    expect((await desktop.loadSettings()).translation.targetLanguage).toBe('auto')
  })

  it('preserves providers and AI settings when a stale translator window changes method', async () => {
    const desktop = new RecordingDesktop()
    const initialProvider = {
      id: 'provider-before-translator-load',
      name: 'Initial provider',
      baseUrl: 'https://initial.example.com/v1',
      protocol: 'responses' as const,
      keyCount: 1,
      availableModels: ['initial-model'],
      enabledModels: ['initial-model'],
    }
    await desktop.saveSettings({
      ...(await desktop.loadSettings()),
      translation: {
        ...(await desktop.loadSettings()).translation,
        aiEnabled: true,
        aiModel: { providerId: initialProvider.id, model: 'initial-model' },
      },
      providers: [initialProvider],
    })
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const latest = await desktop.loadSettings()
    const provider = {
      id: 'provider-after-translator-load',
      name: 'Latest provider',
      baseUrl: 'https://example.com/v1',
      protocol: 'responses' as const,
      keyCount: 1,
      availableModels: ['latest-model'],
      enabledModels: ['latest-model'],
    }
    await desktop.saveSettings({
      ...latest,
      translation: {
        ...latest.translation,
        aiEnabled: true,
        aiModel: { providerId: provider.id, model: 'latest-model' },
        prompt: 'latest custom translation prompt',
      },
      providers: [provider],
    })

    fireEvent.change(screen.getByRole('combobox', { name: '翻译接口' }), {
      target: { value: 'ai' },
    })
    await act(async () => Promise.resolve())

    const saved = await desktop.loadSettings()
    expect(saved.providers).toEqual([provider])
    expect(saved.translation.aiModel).toEqual({
      providerId: provider.id,
      model: 'latest-model',
    })
    expect(saved.translation.prompt).toBe('latest custom translation prompt')
    expect(saved.translation.method).toBe('ai')
  })

  it('closes from the title button and Escape regardless of focus', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: '关闭翻译' }))
    expect(desktop.hides).toBe(1)
    screen.getByRole('combobox', { name: '翻译接口' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(desktop.hides).toBe(2)
  })

  it.each(['Escape', 'button'] as const)('keeps %s closing active during repeated entrances before selection arrives', async (close) => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    const cancel = vi.spyOn(desktop, 'cancelTranslation')
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    for (let entrance = 0; entrance < 2; entrance += 1) {
      const previousCard = screen.getByRole('main')
      await act(async () => {
        desktop.emitTranslatorPrepare()
        await Promise.resolve()
      })
      const card = screen.getByRole('main')
      expect(card).not.toBe(previousCard)
      expect(card).toHaveClass('screenpilot-jelly-pop')
      expect(screen.getByRole('textbox', { name: '原文' })).toHaveValue('')
      cancel.mockClear()

      await act(async () => {
        if (close === 'Escape') {
          screen.getByRole('combobox', { name: '翻译接口' }).focus()
          fireEvent.keyDown(window, { key: 'Escape' })
        } else {
          fireEvent.click(screen.getByRole('button', { name: '关闭翻译' }))
        }
        await Promise.resolve()
      })

      expect(cancel).toHaveBeenCalledTimes(1)
      expect(desktop.hides).toBe(entrance + 1)
      expect(desktop.translations).toHaveLength(0)
    }
  })

  it('shows native commit and close failures without repeating the native hide', async () => {
    const desktop = new RejectingTranslatorDesktop()
    desktop.rejectCommit = true
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByRole('textbox', { name: '原文' })
    fireEvent.change(input, { target: { value: 'commit source' } })

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic commit failure')
    expect(desktop.hides).toBe(0)

    desktop.rejectCommit = false
    desktop.rejectHide = true
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })
    expect(desktop.commits).toEqual(['commit source', 'commit source'])
    expect(desktop.hides).toBe(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭翻译' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic hide failure')
    expect(desktop.hides).toBe(1)
  })

  it('keeps delayed auto-paste cancellation visible when a translated result is present', async () => {
    vi.useFakeTimers()
    const desktop = new RejectingTranslatorDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    const input = screen.getByRole('textbox', { name: '原文' })
    fireEvent.change(input, { target: { value: 'source for guarded paste' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '译文' })).toHaveValue('translated:source for guarded paste')

    desktop.rejectCommit = true
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
      await Promise.resolve()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic commit failure')
  })

  it('retries only a failed translator listener and keeps the successful listener active', async () => {
    const desktop = new RecoveringListenerDesktop()
    desktop.prepareFailures = 1
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    expect(consoleError).toHaveBeenCalledWith(
      '[translator] failed to register prepare listener',
      expect.objectContaining({ message: 'synthetic prepare listener failure' }),
    )
    expect(screen.getByRole('heading', { name: '文本翻译' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('窗口唤起同步暂不可用')
    expect(desktop.prepareAttempts).toBe(1)
    expect(desktop.selectionAttempts).toBe(1)

    await act(async () => {
      desktop.emitTranslatorSelection('listener remains active')
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '原文' })).toHaveValue('listener remains active')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(desktop.prepareAttempts).toBe(2)
    expect(desktop.selectionAttempts).toBe(1)

    await act(async () => {
      desktop.emitTranslatorPrepare()
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '原文' })).toHaveValue('')
  })

  it('cleans up a listener registration that resolves after unmount', async () => {
    const desktop = new DeferredPrepareListenerDesktop()
    const view = render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    view.unmount()

    expect(desktop.selectionUnlistens).toBe(1)
    await act(async () => {
      desktop.resolvePrepare?.(() => { desktop.prepareUnlistens += 1 })
      await Promise.resolve()
    })
    expect(desktop.prepareUnlistens).toBe(1)
  })

  it('uses one explicit drag path for every repeated primary title press', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '文本翻译' })
    const header = heading.closest('header')
    expect(header).not.toBeNull()
    expect(header).not.toHaveAttribute('data-tauri-drag-region')
    expect(header?.closest('[data-tauri-drag-region]:not([data-tauri-drag-region="false"])')).toBeNull()
    expect(header?.querySelector('[data-tauri-drag-region]:not([data-tauri-drag-region="false"])')).toBeNull()
    for (let expected = 1; expected <= 3; expected += 1) {
      fireEvent.pointerDown(heading, { button: 0 })
      expect(desktop.drags).toBe(expected)
    }
  })

  it('ignores non-primary presses, title actions and form controls', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '文本翻译' })
    fireEvent.pointerDown(heading, { button: 1 })
    fireEvent.pointerDown(heading, { button: 2 })
    for (const control of [
      screen.getByRole('button', { name: '翻译历史' }),
      screen.getByRole('button', { name: '关闭翻译' }),
      screen.getByRole('textbox', { name: '原文' }),
      screen.getByRole('textbox', { name: '译文' }),
      screen.getByRole('combobox', { name: '翻译接口' }),
      screen.getByRole('combobox', { name: '目标语言' }),
    ]) {
      fireEvent.pointerDown(control, { button: 0 })
    }
    expect(desktop.drags).toBe(0)
  })

  it('handles a rejected native drag and accepts the next press', async () => {
    const desktop = new RecordingDesktop()
    desktop.rejectNextDrag = true
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '文本翻译' })
    fireEvent.pointerDown(heading, { button: 0 })
    await act(async () => Promise.resolve())
    expect(desktop.dragFailureHandled).toBe(true)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(2)
  })

  it('uses the OCR result card shell and landing animation', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const card = screen.getByRole('main')
    expect(card).toHaveClass('ocr-result-card', 'screenpilot-jelly-pop')
    await act(async () => {
      desktop.emitTranslatorPrepare()
      await Promise.resolve()
    })
    const replayedCard = screen.getByRole('main')
    expect(replayedCard).not.toBe(card)
    expect(replayedCard).toHaveClass('screenpilot-jelly-pop')
    expect(card).toHaveAttribute('data-screenpilot-window-frame', 'true')
    expect(card).toHaveAttribute('data-screenpilot-ocr-card', 'true')
    expect(card.querySelector('.ocr-result-header')).not.toBeNull()
    expect(card.querySelector('.ocr-result-body')).not.toBeNull()
    expect(card.querySelector('.ocr-result-divider')).not.toBeNull()
    expect(card.querySelector('.translator-divider')).toBeNull()
    const separator = screen.getByRole('separator', { name: '调整原文和译文高度' })
    expect(separator).toHaveAttribute('aria-valuenow', '38')
    fireEvent.keyDown(separator, { key: 'ArrowUp' })
    expect(separator).toHaveAttribute('aria-valuenow', '34')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '24')
    expect(localStorage.getItem('screenpilot:translator-ocr-golden-split')).toBe('0.24')
    expect(screen.getByText('原文')).toBeVisible()
    expect(screen.getByText('译文')).toBeVisible()
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: '目标语言' })).toBeVisible()
  })
})
