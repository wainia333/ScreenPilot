import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import type { TranslationRequest, TranslationResult } from '../../desktop/contract'
import { TranslatorPage } from './translator-page'

class RecordingDesktop extends FakeDesktopPort {
  readonly translations: TranslationRequest[] = []
  readonly commits: string[] = []
  hides = 0
  drags = 0
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
    return Promise.resolve()
  }

  override takeTranslatorSelection(): Promise<string> {
    return Promise.resolve(this.selection)
  }
}

describe('TranslatorPage', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('waits 600ms, ignores IME submit and commits after composition ends', async () => {
    vi.useFakeTimers()
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByLabelText('原文')
    fireEvent.change(input, { target: { value: 'sample' } })
    await act(() => vi.advanceTimersByTime(599))
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
      vi.advanceTimersByTime(600)
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
      vi.advanceTimersByTime(600)
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
    expect(language).toHaveValue('auto')
    expect(screen.getByRole('option', { name: '简体中文' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'English' })).toBeVisible()
    fireEvent.change(language, { target: { value: 'ja' } })
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(desktop.translations.at(-1)?.targetLanguage).toBe('ja')
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

  it('starts dragging from the full non-interactive title area only', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><TranslatorPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.pointerDown(screen.getByRole('heading', { name: '文本翻译' }), { button: 0 })
    expect(desktop.drags).toBe(1)
    const close = screen.getByRole('button', { name: '关闭翻译' })
    fireEvent.pointerDown(close, { button: 0 })
    fireEvent.click(close)
    expect(desktop.drags).toBe(1)
    expect(desktop.hides).toBe(1)
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
