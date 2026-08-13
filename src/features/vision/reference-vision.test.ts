import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeExternalUrl } from './citation-links'

const adapterStyles = readFileSync(resolve(process.cwd(), 'src/features/vision/vision-adapter.css'), 'utf8')
const adapterSource = readFileSync(resolve(process.cwd(), 'src/features/vision/reference-vision.tsx'), 'utf8')
const visionSource = readFileSync(resolve(process.cwd(), 'src/vendor/kivio-screenshot/Vision.tsx'), 'utf8')
const adapterStyleElement = document.createElement('style')
adapterStyleElement.textContent = adapterStyles
document.head.append(adapterStyleElement)

describe('Vision citation links', () => {
  it('allows only absolute HTTP(S) links for the external opener', () => {
    expect(safeExternalUrl('https://example.com/source')).toBe('https://example.com/source')
    expect(safeExternalUrl('http://127.0.0.1:8080/source')).toBe('http://127.0.0.1:8080/source')
    expect(safeExternalUrl('/inside-vision')).toBeNull()
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,alert(1)')).toBeNull()
  })
})

describe('Vision prompt input layout', () => {
  it.each([
    ['Chinese', '这是一段很长的中文输入内容，用于验证光标继续输入时不会被右侧操作按钮遮挡。'],
    ['English', 'This is a long English prompt used to keep the caret visible while typing past the input width.'],
  ])('keeps the %s prompt input shrinkable and horizontally scrollable', (_language, value) => {
    const promptBar = document.createElement('div')
    promptBar.dataset.screenpilotPromptBar = 'true'
    const input = document.createElement('input')
    input.dataset.screenpilotVisionPrompt = 'true'
    input.value = value.repeat(4)
    promptBar.append(input)
    document.body.append(promptBar)

    const style = getComputedStyle(input)
    expect(style.width).toBe('0px')
    expect(style.minWidth).toBe('0px')
    expect(style.maxWidth).toBe('100%')
    expect(style.flex).toBe('1 1 0%')
    expect(style.appearance).toBe('none')
    expect(Number.parseFloat(style.paddingLeft)).toBe(0)
    expect(Number.parseFloat(style.paddingRight)).toBe(8)
    expect(style.borderRightWidth).toBe('1px')
    expect(style.borderRightStyle).toBe('solid')
    expect(style.borderRightColor).toBe('rgba(0, 0, 0, 0)')
    expect(style.overflowX).toBe('auto')
    expect(style.overflowY).toBe('hidden')
    expect(style.whiteSpace).toBe('nowrap')

    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    expect(input.selectionStart).toBe(input.value.length)
    const beforeDelete = input.value
    input.value = input.value.slice(0, -1)
    expect(input.value).toHaveLength(beforeDelete.length - 1)
    promptBar.remove()
  })
})

describe('Vision adapter DOM contract', () => {
  it('uses explicit vendor markers instead of text, class, or sibling fallbacks', () => {
    expect(adapterSource).not.toContain(':has(')
    expect(adapterSource).not.toContain('placeholder="')
    expect(adapterSource).not.toContain('classList.contains')
    expect(adapterSource).not.toContain('previousElementSibling')
    expect(adapterSource).not.toContain('parentElement')

    for (const marker of [
      'data-screenpilot-vision-root',
      'data-screenpilot-translation-card',
      'data-screenpilot-translation-header',
      'data-screenpilot-translation-body',
      'data-screenpilot-ocr-container',
      'data-screenpilot-original-heading',
      'data-screenpilot-ocr-source-content',
      'data-screenpilot-translated-heading',
      'data-screenpilot-target-result-slot',
      'data-screenpilot-answer-panel',
      'data-screenpilot-answer-scroll',
      'data-screenpilot-answer-actions',
    ]) {
      expect(visionSource).toContain(marker)
    }
  })

  it('observes only the adapter root and receives precise component events', () => {
    expect(adapterSource).toContain('observer.observe(adapterRoot')
    expect(adapterSource).not.toContain('observer.observe(document.body')
    expect(adapterSource).toContain("screenpilot:vision-contract-change")
    expect(adapterSource).toContain("screenpilot:vision-session-reset")
    expect(visionSource).toContain("screenpilot:vision-session-reset")
  })
})
