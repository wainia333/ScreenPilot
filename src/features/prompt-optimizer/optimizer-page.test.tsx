import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import type { PromptOptimizationRequest, PromptOptimizationResult } from '../../desktop/contract'
import { OptimizerPage } from './optimizer-page'

class RecordingDesktop extends FakeDesktopPort {
  readonly optimizations: PromptOptimizationRequest[] = []
  hides = 0
  drags = 0

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
    fireEvent.pointerDown(screen.getByRole('heading', { name: '提示词优化' }), { button: 0 })
    expect(desktop.drags).toBe(1)
    const close = screen.getByRole('button', { name: '关闭优化器' })
    fireEvent.pointerDown(close, { button: 0 })
    fireEvent.click(close)
    expect(desktop.drags).toBe(1)
    expect(desktop.hides).toBe(1)
    screen.getByRole('textbox', { name: '原始提示词' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(desktop.hides).toBe(2)
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
})
