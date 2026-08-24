import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeExternalUrl } from './citation-links'

const adapterStyles = readFileSync(resolve(process.cwd(), 'src/features/vision/vision-adapter.css'), 'utf8')
const adapterSource = readFileSync(resolve(process.cwd(), 'src/features/vision/reference-vision.tsx'), 'utf8')
const visionSource = readFileSync(resolve(process.cwd(), 'src/vendor/kivio-screenshot/Vision.tsx'), 'utf8')
const visionStyles = readFileSync(resolve(process.cwd(), 'src/vendor/kivio-screenshot/index.css'), 'utf8')
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

describe('Vision translation edit debounce', () => {
  it('keeps the fixed 1500ms edit debounce in the vendored surface', () => {
    expect(visionSource).toContain('scheduleVisionTranslationEdit')
    expect(visionSource).toContain("from '../../features/vision/translation-edit-debounce'")
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

describe('Vision answer readability', () => {
  it('keeps answer actions in normal flow instead of covering conversation text', () => {
    const panelRule = /\[data-screenpilot-answer-panel="true"\]\s*\{(?<body>[^}]*)\}/
      .exec(adapterStyles)?.groups?.body
    const scrollRule = /\[data-screenpilot-answer-scroll="true"\]\s*\{(?<body>[^}]*)\}/
      .exec(adapterStyles)?.groups?.body
    const actionsRule = /\[data-screenpilot-answer-actions="true"\]\s*\{(?<body>[^}]*)\}/
      .exec(adapterStyles)?.groups?.body

    expect(panelRule).toBeDefined()
    expect(panelRule).toContain('display: flex')
    expect(panelRule).toContain('flex-direction: column')
    expect(scrollRule).toBeDefined()
    expect(scrollRule).toContain('min-height: 0')
    expect(scrollRule).toContain('flex: 1 1 auto')
    expect(scrollRule).toContain('overflow-y: auto')
    expect(actionsRule).toBeDefined()
    expect(actionsRule).toContain('position: static')
    expect(actionsRule).toContain('flex-shrink: 0')
    expect(actionsRule).toContain('order: 0')
    expect(actionsRule).toContain('margin-top: auto')
    expect(actionsRule).not.toContain('position: sticky')
    expect(actionsRule).not.toContain('bottom: 0')
  })

  it('renders the fixed action row after the answer scroll port', () => {
    const answerScrollToActions = /data-screenpilot-answer-scroll="true"[\s\S]*?\n\s*<\/div>\s*\n\s*\{showActions && Actions\}/

    expect(visionSource).toMatch(answerScrollToActions)
    expect(visionSource.match(/\{showActions && Actions\}/g)).toHaveLength(1)
    expect(visionSource).toContain('data-screenpilot-export-target="answer"')
    expect(visionSource).toContain('visionExportMarkdown')
    expect(visionSource).toContain('cursor-pointer')
  })

  it('provides animated per-message actions and role-specific editors', () => {
    expect(adapterStyles).toContain('[data-screenpilot-message-toolbar="true"]')
    expect(adapterStyles).toContain('transition: opacity 200ms cubic-bezier(0.4, 0, 0.2, 1)')
    expect(adapterStyles).not.toContain('data-screenpilot-message-action]:not(:disabled):hover::before')
    expect(adapterStyles).not.toContain('transform: translateY(5px) scale(0.96)')
    expect(visionSource).toContain('inline-flex items-center justify-end gap-1.5 bg-transparent')
    expect(visionSource).toContain("role === 'user' ? 'right-0 bottom-px' : 'left-0 bottom-0'")
    expect(visionSource).toContain('h-[26px] w-[26px]')
    expect(visionSource).toContain("'mb-3 pb-[30px]'")
    expect(visionSource).toContain("data-screenpilot-message-pair-gap={isCompactPairTail ? 'compact' : 'standard'}")
    expect(visionSource).toContain("isCompactPairTail ? '-mt-[6px]' : ''")
    expect(visionSource).toContain("!isUser && previousMessage?.role === 'user'")
    expect(visionSource).toContain("isUser && previousMessage?.role === 'assistant'")
    expect(visionSource).toContain('enabled:cursor-pointer enabled:hover:bg-black/[0.06]')
    expect(visionSource).not.toContain('gap-0.5 rounded-lg border border-black/[0.08] bg-white/85')
    expect(visionSource).toContain('data-screenpilot-message-shell="true"')
    expect(visionSource).toContain('data-screenpilot-message-action="speak"')
    expect(visionSource).toContain('data-screenpilot-message-action="regenerate"')
    expect(visionSource).toContain('data-screenpilot-message-action="edit"')
    expect(visionSource).toContain('data-screenpilot-message-action="copy"')
    expect(visionSource).toContain('data-screenpilot-message-editor-action="save"')
    expect(visionSource).toContain('data-screenpilot-message-editor-action="cancel"')
    expect(visionSource).toContain('restartVisionFromMessage(origIdx, editingMessageDraft)')
  })

  it('uses a strong selection highlight only inside Vision code blocks', () => {
    expect(visionSource).toContain('data-screenpilot-markdown-code="true"')
    expect(visionStyles).toMatch(
      /\[data-screenpilot-markdown-code="true"\] ::selection\s*\{[^}]*background: #2563eb;[^}]*color: #ffffff;/,
    )
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
