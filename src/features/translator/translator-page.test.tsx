import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import type { TranslationRequest, TranslationResult } from '../../desktop/contract'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { TRANSLATOR_INPUT_DEBOUNCE_MS, TranslatorPage } from './translator-page'

class RecordingDesktop extends FakeDesktopPort {
  readonly translations: TranslationRequest[] = []
  readonly commits: string[] = []
  hides = 0
  drags = 0
  rejectNextDrag = false
  dragFailureHandled = false
  selection = ''

  override translate(request: TranslationRequest): Promise<TranslationResult> {
    this.translations.push(request)
    return Promise.resolve({ generation: request.generation, text: `translated:${request.text}` })
  }

  override commitText(text: string): Promise<void> {
    this.commits.push(text)
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

describe('TranslatorPage', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('waits 700ms, ignores IME submit and commits after composition ends', async () => {
    vi.useFakeTimers()
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

  it('injects the hotkey selection and translates it without manual editing', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    desktop.selection = 'selected source'
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByLabelText('原文')).toHaveValue('selected source')
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
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
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)?.text).toBe('delayed selection')
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
    expect(historyButton).toHaveClass('history-button')
    expect(historyButton.querySelector('.history-count-badge')).toHaveTextContent('20')
    expect(screen.getByText('历史记录：20 条')).toBeInTheDocument()
    fireEvent.click(historyButton)
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(historyButton.querySelector('.history-count-badge')).toBeNull()
    expect(screen.getByText('暂无历史记录')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'new source' } })
    await act(async () => {
      vi.advanceTimersByTime(TRANSLATOR_INPUT_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(historyButton.querySelector('.history-count-badge')).toHaveTextContent('1')
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

  it('preserves providers and AI settings when a stale translator window changes method', async () => {
    const desktop = new RecordingDesktop()
    const initialProvider = {
      id: 'provider-before-translator-load',
      name: 'Initial provider',
      baseUrl: 'https://initial.example.com/v1',
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
    expect(screen.getByRole('separator', { name: '调整原文和译文高度' })).toHaveAttribute('aria-valuenow', '38')
    expect(screen.getByText('原文')).toBeVisible()
    expect(screen.getByText('译文')).toBeVisible()
    expect(screen.getByRole('combobox', { name: '翻译接口' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: '目标语言' })).toBeVisible()
  })
})
