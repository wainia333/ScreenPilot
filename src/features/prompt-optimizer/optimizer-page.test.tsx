import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import type { PromptOptimizationRequest, PromptOptimizationResult } from '../../desktop/contract'
import { observedDragRejection } from '../../shared/testing/observed-drag-rejection'
import { OptimizerPage } from './optimizer-page'

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

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

class DeferredOptimizerDesktop extends RecordingDesktop {
  readonly pending: {
    request: PromptOptimizationRequest
    resolve: (result: PromptOptimizationResult) => void
  }[] = []

  override optimizePrompt(request: PromptOptimizationRequest): Promise<PromptOptimizationResult> {
    this.optimizations.push(request)
    return new Promise((resolve) => {
      this.pending.push({ request, resolve })
    })
  }
}

class RejectingHideOptimizerDesktop extends RecordingDesktop {
  override hideWindow(): Promise<void> {
    this.hides += 1
    return Promise.reject(new Error('synthetic optimizer hide failure'))
  }
}

describe('OptimizerPage', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    localStorage.clear()
    sessionStorage.clear()
  })

  it('loads the saved English interface language for the standalone optimizer', async () => {
    const desktop = new RecordingDesktop()
    await desktop.saveSettings({ ...(await desktop.loadSettings()), language: 'en' })
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)

    expect(await screen.findByRole('heading', { name: 'Prompt Optimizer' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Original prompt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close optimizer' })).toBeInTheDocument()
    await act(async () => Promise.resolve())
    expect(document.documentElement).toHaveAttribute('lang', 'en')
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
    const separator = screen.getByRole('separator', { name: '调整原始提示词和优化结果高度' })
    expect(separator).toHaveAttribute('aria-valuenow', '38')
    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(separator).toHaveAttribute('aria-valuenow', '42')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '76')
    expect(localStorage.getItem('screenpilot:optimizer-golden-split-v2')).toBe('0.76')
    const close = screen.getByRole('button', { name: '关闭优化器' })
    fireEvent.click(close)
    expect(desktop.hides).toBe(1)
    screen.getByRole('textbox', { name: '原始提示词' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(desktop.hides).toBe(2)
  })

  it('shows native close failures from the button and Escape without leaking rejected promises', async () => {
    const desktop = new RejectingHideOptimizerDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭优化器' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic optimizer hide failure')

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic optimizer hide failure')
    expect(desktop.hides).toBe(2)
  })

  it('keeps a close failure when an in-flight optimization resolves later', async () => {
    class DeferredRejectingHideDesktop extends DeferredOptimizerDesktop {
      override hideWindow(): Promise<void> {
        this.hides += 1
        return Promise.reject(new Error('synthetic active close failure'))
      }
    }
    const desktop = new DeferredRejectingHideDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.change(screen.getByRole('textbox', { name: '原始提示词' }), { target: { value: 'active prompt' } })
    fireEvent.click(screen.getByRole('button', { name: '优化' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭优化器' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic active close failure')

    await act(async () => {
      desktop.pending[0]?.resolve({ generation: desktop.pending[0].request.generation, text: 'late result' })
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Error: synthetic active close failure')
    expect(screen.queryByDisplayValue('late result')).not.toBeInTheDocument()
    expect(localStorage.getItem('screenpilot:optimizer-history')).toBeNull()
    expect(desktop.promptOptimizationCancelCalls).toHaveLength(1)
  })

  it('cancels a hidden in-flight request and ignores its late result and history write', async () => {
    const desktop = new DeferredOptimizerDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.change(screen.getByRole('textbox', { name: '原始提示词' }), {
      target: { value: 'prompt hidden during optimization' },
    })
    fireEvent.click(screen.getByRole('button', { name: '优化' }))
    expect(desktop.pending).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭优化器' }))
      await Promise.resolve()
    })
    expect(desktop.hides).toBe(1)
    expect(desktop.promptOptimizationCancelCalls).toHaveLength(1)
    expect(desktop.promptOptimizationCancelCalls[0]).toBeGreaterThan(desktop.pending[0]?.request.generation ?? 0)

    await act(async () => {
      desktop.pending[0]?.resolve({
        generation: desktop.pending[0].request.generation,
        text: 'late hidden result',
      })
      await Promise.resolve()
    })
    expect(screen.queryByDisplayValue('late hidden result')).not.toBeInTheDocument()
    expect(localStorage.getItem('screenpilot:optimizer-history')).toBeNull()
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

  it('discards an in-flight result after the source prompt changes', async () => {
    const desktop = new DeferredOptimizerDesktop()
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const input = screen.getByRole('textbox', { name: '原始提示词' })
    fireEvent.change(input, { target: { value: 'first prompt' } })
    fireEvent.click(screen.getByRole('button', { name: '优化' }))
    expect(desktop.pending).toHaveLength(1)
    expect(screen.getByRole('button', { name: '优化中…' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'latest prompt' } })
    expect(screen.getByRole('textbox', { name: '优化结果' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '复制优化结果' })).toBeDisabled()
    await act(async () => {
      desktop.pending[0]?.resolve({
        generation: desktop.pending[0].request.generation,
        text: 'stale optimized result',
      })
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '优化结果' })).toHaveValue('')
    expect(localStorage.getItem('screenpilot:optimizer-history')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '优化' }))
    expect(desktop.pending).toHaveLength(2)
    await act(async () => {
      desktop.pending[1]?.resolve({
        generation: desktop.pending[1].request.generation,
        text: 'latest optimized result',
      })
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: '优化结果' })).toHaveValue('latest optimized result')
    expect(localStorage.getItem('screenpilot:optimizer-history')).toContain('latest prompt')
    expect(localStorage.getItem('screenpilot:optimizer-history')).not.toContain('first prompt')
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
    render(<DesktopProvider port={desktop}><OptimizerPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.change(screen.getByRole('textbox', { name: '原始提示词' }), {
      target: { value: 'copy prompt' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '优化' }))
      await Promise.resolve()
    })
    const copy = screen.getByRole('button', { name: '复制优化结果' })

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenNthCalledWith(1, 'optimized:copy prompt')
    expect(screen.getByText('复制失败，请检查剪贴板权限')).toHaveAttribute('aria-live', 'polite')

    await act(async () => {
      fireEvent.click(copy)
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenNthCalledWith(2, 'optimized:copy prompt')
    expect(screen.queryByText('复制失败，请检查剪贴板权限')).not.toBeInTheDocument()
    expect(copy.querySelector('.lucide-check')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTime(1200))
    expect(copy.querySelector('.lucide-clipboard')).toBeInTheDocument()
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
    const menu = screen.getByRole('dialog', { name: '优化历史' })
    expect(menu.querySelector('.history-menu-input')).toHaveTextContent('saved prompt')
    expect(menu.querySelector('.history-menu-output')).toBeNull()
    expect(menu).not.toHaveTextContent('saved result')
    fireEvent.click(screen.getByRole('button', { name: '删除历史' }))
    expect(historyButton.querySelector('.history-count-badge')).toBeNull()
    expect(historyButton).not.toHaveClass('history-button-count-1')
    expect(within(screen.getByRole('dialog', { name: '优化历史' })).getByText('暂无历史记录')).toBeInTheDocument()
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
