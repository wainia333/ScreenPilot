import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import type { PromptOptimizationRequest, PromptOptimizationResult } from '../../desktop/contract'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { OptimizerPage } from './optimizer-page'

class RecordingDesktop extends FakeDesktopPort {
  readonly optimizations: PromptOptimizationRequest[] = []
  hides = 0
  drags = 0
  rejectNextDrag = false
  dragFailureHandled = false

  override optimizePrompt(request: PromptOptimizationRequest): Promise<PromptOptimizationResult> {
    this.optimizations.push(request)
    return Promise.resolve({
      generation: request.generation,
      text: `optimized:${request.text}`,
    })
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
}

describe('OptimizerPage', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('uses the OCR result card shell and closes without entering drag mode', async () => {
    localStorage.setItem('screenpilot:optimizer-ocr-golden-split', '0.7')
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const card = screen.getByRole('main')
    expect(card).toHaveClass('ocr-result-card', 'optimizer-window', 'screenpilot-jelly-pop')
    expect(card).toHaveAttribute('data-screenpilot-window-frame', 'true')
    expect(card).toHaveAttribute('data-screenpilot-ocr-card', 'true')
    expect(card.querySelector('.ocr-result-header')).not.toBeNull()
    expect(card.querySelector('.ocr-result-body')).not.toBeNull()
    expect(card.querySelector('.ocr-result-divider')).not.toBeNull()
    expect(card.querySelector('.translator-divider')).toBeNull()
    expect(screen.getByRole('separator', { name: '调整原始提示词和优化结果高度' })).toHaveAttribute('aria-valuenow', '38')
    const close = screen.getByRole('button', { name: '关闭优化器' })
    fireEvent.click(close)
    expect(desktop.hides).toBe(1)
    screen.getByRole('textbox', { name: '原始提示词' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(desktop.hides).toBe(2)
  })

  it('uses one explicit drag path for every repeated primary title press', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '提示词优化' })
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
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '提示词优化' })
    fireEvent.pointerDown(heading, { button: 1 })
    fireEvent.pointerDown(heading, { button: 2 })
    for (const control of [
      screen.getByRole('button', { name: '优化历史' }),
      screen.getByRole('button', { name: '关闭优化器' }),
      screen.getByRole('textbox', { name: '原始提示词' }),
      screen.getByRole('textbox', { name: '优化结果' }),
      screen.getByRole('button', { name: '优化' }),
    ]) {
      fireEvent.pointerDown(control, { button: 0 })
    }
    expect(desktop.drags).toBe(0)
  })

  it('handles a rejected native drag and accepts the next press', async () => {
    const desktop = new RecordingDesktop()
    desktop.rejectNextDrag = true
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const heading = screen.getByRole('heading', { name: '提示词优化' })
    fireEvent.pointerDown(heading, { button: 0 })
    await act(async () => Promise.resolve())
    expect(desktop.dragFailureHandled).toBe(true)
    fireEvent.pointerDown(heading, { button: 0 })
    expect(desktop.drags).toBe(2)
  })

  it('requests only on demand and keeps editable output', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByRole('textbox', { name: '原始提示词' })
    fireEvent.change(input, { target: { value: 'Summarize the supplied material.' } })
    expect(screen.getByRole('textbox', { name: '优化结果' })).toHaveValue('')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '优化' }))
      await Promise.resolve()
    })
    expect(desktop.optimizations).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '优化结果' })).toHaveValue('optimized:Summarize the supplied material.')
  })

  it('shows and synchronizes the optimization history badge', async () => {
    localStorage.setItem('screenpilot:optimizer-history', JSON.stringify([{
      id: 'saved-optimization',
      input: 'saved prompt',
      output: 'saved result',
      updatedAt: 4,
    }]))
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const historyButton = screen.getByRole('button', { name: '优化历史' })
    expect(historyButton).toHaveClass('ocr-header-button', 'history-button')
    expect(historyButton).toHaveClass('history-button-count-1')
    expect(historyButton.querySelector('.history-count-badge')).toHaveTextContent('1')
    expect(screen.getByText('历史记录：1 条')).toBeInTheDocument()
    fireEvent.click(historyButton)
    const menu = screen.getByRole('complementary', { name: '优化历史' })
    expect(menu.querySelector('.history-menu-input')).toHaveTextContent('saved prompt')
    expect(menu.querySelector('.history-menu-output')).toBeNull()
    expect(menu).not.toHaveTextContent('saved result')
    fireEvent.click(screen.getByRole('button', { name: '删除历史' }))
    expect(historyButton.querySelector('.history-count-badge')).toBeNull()
    expect(historyButton).not.toHaveClass('history-button-count-1')
    expect(within(screen.getByRole('complementary', { name: '优化历史' })).getByText('暂无历史记录')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '原始提示词' }), {
      target: { value: 'new prompt' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '优化' }))
      await Promise.resolve()
    })
    expect(historyButton).toHaveClass('history-button-count-1')
    expect(historyButton.querySelector('.history-count-badge')).toHaveTextContent('1')
  })
})
