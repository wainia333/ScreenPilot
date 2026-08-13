import { createContext, isValidElement, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent, type ClipboardEvent, type ComponentPropsWithoutRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Loader2, Copy, Check, Square, Image as ImageIcon, ArrowUp, History as HistoryIcon, ChevronDown, Brain, MousePointer2, Play, X, Sparkles, MessageSquare } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api, type VisionStreamPayload, type VisionTranslateStreamPayload, type VisionWindowInfo, type ExplainMessage, type Settings } from './api/tauri'
import {
  loadVisionHistory,
  saveVisionHistory,
  VISION_HISTORY_MAX as HISTORY_MAX,
  VISION_HISTORY_REPAIR_NOTICE_KEY,
  type VisionCapturedFrame as CapturedFrame,
  type VisionHistoryItem as HistoryItem,
  type VisionHistoryLoadResult,
} from './history'
import {
  adjustKeyboardArrow,
  adjustKeyboardRegion,
  defaultKeyboardArrow,
  defaultKeyboardRegion,
  nextWindowIndex,
} from './accessibility'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { i18n, type Lang } from './settings/i18n'
import { copyToClipboard } from './utils/clipboard'
import {
  shouldPromoteVisionBarLayer,
  shouldReactOwnVisionFloatingResize,
  shouldRunVisionLandingJelly,
  VISION_FLOATING_PADDING,
} from '../../features/vision/dialog-sizing'
import { appendVisionError, mergeVisionResponse, VisionRequestLifecycle } from '../../features/vision/request-lifecycle'
import {
  resolveVisionSpeechFailure,
  visionSpeechControlLabel,
  type VisionSpeechTarget as SpeechTarget,
} from '../../features/vision/speech-feedback'

type Stage = 'select' | 'ready' | 'answering' | 'translating' | 'translated'
type Mode = 'chat' | 'translate'
type ScreenshotOcrMethod = NonNullable<Settings['screenshotTranslation']['ocrMethod']>
type ScreenshotTranslationMethod = NonNullable<Settings['screenshotTranslation']['translationMethod']>

const APPLE_INTELLIGENCE_BASE_URL = 'applefoundation://local'
const VisionLanguageContext = createContext<Lang>('zh')
type VisionCopyFeedback = {
  begin: () => number
  isCurrent: (sequence: number) => boolean
  clearFailure: () => void
  reportFailure: (message: string) => void
}
const VisionCopyFeedbackContext = createContext<VisionCopyFeedback | null>(null)

type FloatingRectRequest = Parameters<typeof api.visionSetFloating>[0]

/**
 * Native Windows can reject a geometry update while the user is still moving
 * the window (GUI_INMOVESIZE). Keep retrying on animation frames until the
 * exact request is applied, while letting every caller invalidate the loop when
 * its geometry/profile or lifecycle changes.
 */
function setVisionFloatingWithRetry(
  rect: FloatingRectRequest,
  isCurrent: () => boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false
    let retryFrame: number | null = null

    const finish = (applied: boolean) => {
      if (settled) return
      settled = true
      if (retryFrame !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(retryFrame)
        retryFrame = null
      }
      resolve(applied)
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      if (retryFrame !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(retryFrame)
        retryFrame = null
      }
      reject(error)
    }

    const attempt = () => {
      if (settled || !isCurrent()) {
        finish(false)
        return
      }
      void api.visionSetFloating(rect)
        .then((applied) => {
          if (settled) return
          if (!isCurrent()) {
            finish(false)
            return
          }
          if (applied) {
            finish(true)
            return
          }
          if (typeof window === 'undefined') {
            finish(false)
            return
          }
          retryFrame = window.requestAnimationFrame(() => {
            retryFrame = null
            attempt()
          })
        })
        .catch((error) => {
          if (!isCurrent()) finish(false)
          else fail(error)
        })
    }

    attempt()
  })
}

function readModeFromHash(): Mode {
  if (typeof window === 'undefined') return 'chat'
  const hash = window.location.hash || ''
  const q = hash.indexOf('?')
  if (q < 0) return 'chat'
  const params = new URLSearchParams(hash.slice(q + 1))
  return params.get('mode') === 'translate' ? 'translate' : 'chat'
}

function resolveVisionModelLabel(settings: Settings): string {
  return settings.vision?.model?.trim() || settings.translatorModel?.trim() || 'AI'
}

function resolveScreenshotOcrMethod(settings: Settings): ScreenshotOcrMethod {
  const method = settings.screenshotTranslation?.ocrMethod
  if (method === 'system' || settings.screenshotTranslation?.useSystemOcr) return 'chaoxing'
  return method || 'ai'
}

function resolveScreenshotTranslationMethod(settings: Settings): ScreenshotTranslationMethod {
  return settings.screenshotTranslation?.translationMethod || 'ai'
}

function providerKeyConfigError(
  settings: Settings,
  providerId: string,
  missingProvider: string,
  missingKey: string,
): string {
  const provider = settings.providers.find(p => p.id === providerId.trim())
  if (!provider) return missingProvider
  if (provider.baseUrl === APPLE_INTELLIGENCE_BASE_URL) return ''
  return provider.keyCount > 0 ? '' : missingKey
}

function ocrConfigError(settings: Settings, method: ScreenshotOcrMethod, lang: Lang): string {
  const zh = lang === 'zh'
  const st = settings.screenshotTranslation
  if (method === 'baidu') {
    const cfg = st.baiduOcr
    if (!cfg?.apiKeyConfigured || !cfg.secretKeyConfigured) {
      return zh
        ? '请先在设置中配置百度 OCR API Key 和 Secret Key。'
        : 'Configure the Baidu OCR API Key and Secret Key in Settings first.'
    }
  }
  if (method === 'ai') {
    return providerKeyConfigError(
      settings,
      st.providerId || '',
      zh ? '请先在设置中选择可用的 AI OCR 接口。' : 'Choose an available AI OCR provider in Settings first.',
      zh ? '请先在设置中为 AI OCR 接口配置 API 密钥。' : 'Configure an API key for the AI OCR provider in Settings first.',
    )
  }
  return ''
}

function translationConfigError(settings: Settings, method: ScreenshotTranslationMethod, lang: Lang): string {
  const zh = lang === 'zh'
  const st = settings.screenshotTranslation
  if (method === 'ai') {
    return providerKeyConfigError(
      settings,
      st.translateProviderId || st.providerId || '',
      zh ? '请先在设置中选择可用的 AI 翻译接口。' : 'Choose an available AI translation provider in Settings first.',
      zh ? '请先在设置中为 AI 翻译接口配置 API 密钥。' : 'Configure an API key for the AI translation provider in Settings first.',
    )
  }
  if (method === 'baidu') {
    const cfg = st.baiduTranslate
    if (!cfg?.appIdConfigured || !cfg.appKeyConfigured) {
      return zh
        ? '请先在设置中配置百度翻译 APP ID 和 APP Key。'
        : 'Configure the Baidu Translate APP ID and APP Key in Settings first.'
    }
  }
  if (method === 'tencent') {
    const cfg = st.tencentTranslate
    if (!cfg?.secretIdConfigured || !cfg.secretKeyConfigured) {
      return zh
        ? '请先在设置中配置腾讯云 SecretId 和 SecretKey。'
        : 'Configure the Tencent Cloud SecretId and SecretKey in Settings first.'
    }
  }
  if (method === 'caiyun2') {
    if (!st.caiyunTranslate?.tokenConfigured) {
      return zh
        ? '请先在设置中配置彩云小译 Token。'
        : 'Configure the Caiyun token in Settings first.'
    }
  }
  return ''
}

function formatVisionAsking(template: string, model: string): string {
  return template.replace('{model}', model || 'AI')
}

function defaultImageAnalysisQuestion(lang: Lang): string {
  return lang === 'zh' ? '请分析这张截图。' : 'Please analyze this screenshot.'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isAsciiAlphaNumeric(ch: string | undefined): boolean {
  return !!ch && /^[A-Za-z0-9]$/.test(ch)
}

function isAsciiLetter(ch: string | undefined): boolean {
  return !!ch && /^[A-Za-z]$/.test(ch)
}

function isAsciiUppercase(ch: string | undefined): boolean {
  return !!ch && /^[A-Z]$/.test(ch)
}

function isUppercaseAcronymEnd(chars: string[], index: number): boolean {
  if (chars[index] !== '.' || !isAsciiUppercase(chars[index - 1])) return false
  let count = 1
  let cursor = index - 2
  while (cursor >= 1 && chars[cursor] === '.' && isAsciiUppercase(chars[cursor - 1])) {
    count += 1
    cursor -= 2
  }
  return count >= 2
}

function shouldAddSpaceAfterEnglishPunctuation(chars: string[], index: number): boolean {
  const ch = chars[index]
  if (!['.', ',', ';', ':', '?', '!'].includes(ch)) return false

  const prev = chars[index - 1]
  const prevPrev = chars[index - 2]
  const next = chars[index + 1]
  if (!isAsciiAlphaNumeric(next)) return false
  if (next && /\s/.test(next)) return false
  if ((ch === '.' || ch === ',' || ch === ':') && /\d/.test(prev || '') && /\d/.test(next)) return false
  if (ch === '.' && isAsciiLetter(prev) && isAsciiLetter(next)) {
    const singleLetterAbbrev = !isAsciiLetter(prevPrev) || prevPrev === '.'
    if (singleLetterAbbrev && !(isUppercaseAcronymEnd(chars, index) && !isAsciiUppercase(next))) return false
  }
  return true
}

function normalizeEnglishPunctuationSpacing(value: string): string {
  if (!value) return value
  const chars = Array.from(value)
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    out += chars[i]
    if (shouldAddSpaceAfterEnglishPunctuation(chars, i)) out += ' '
  }
  return out
}

function readableParagraphGapClass(value: string): string {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(value)
    ? 'vision-readable-cjk'
    : 'vision-readable-latin'
}

function editableOcrHtml(value: string): string {
  const normalized = normalizeEnglishPunctuationSpacing(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
  if (!normalized) return '<div data-ocr-paragraph><br></div>'
  return normalized
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => (
      `<div data-ocr-paragraph>${block.split('\n').map(line => escapeHtml(line)).join('<br>')}</div>`
    ))
    .join('')
}

function nodeEditableText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (!(node instanceof HTMLElement)) return ''
  if (node.tagName === 'BR') return '\n'
  return Array.from(node.childNodes).map(nodeEditableText).join('')
}

function isEditableBlock(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false
  return node.hasAttribute('data-ocr-paragraph')
    || ['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.tagName)
}

function readEditableOcrText(root: HTMLElement): string {
  const blocks: string[] = []
  let inline = ''
  const flushInline = () => {
    const text = inline.trim()
    if (text) blocks.push(text)
    inline = ''
  }

  Array.from(root.childNodes).forEach(node => {
    if (isEditableBlock(node)) {
      flushInline()
      const text = nodeEditableText(node).replace(/\u00a0/g, ' ').trim()
      if (text) blocks.push(text)
    } else {
      inline += nodeEditableText(node)
    }
  })
  flushInline()

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function splitSpeechText(value: string): string[] {
  const maxChars = 450
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\*{3}/g, '')
    .trim()
  if (!normalized) return []

  const chunks: string[] = []
  let current = ''
  const flush = () => {
    const text = current.trim()
    if (text) chunks.push(text)
    current = ''
  }
  const pushSegment = (segment: string) => {
    const text = segment.trim()
    if (!text) return
    const chars = Array.from(text)
    if (chars.length > maxChars) {
      flush()
      for (let i = 0; i < chars.length; i += maxChars) {
        chunks.push(chars.slice(i, i + maxChars).join('').trim())
      }
      return
    }
    const nextLen = Array.from(current).length + (current ? 1 : 0) + chars.length
    if (nextLen > maxChars) flush()
    current = current ? `${current}\n${text}` : text
  }

  normalized.split(/\n+/).forEach(line => {
    const parts = line
      .split(/([。！？；.!?;]+)/)
      .reduce<string[]>((acc, part, idx, arr) => {
        if (idx % 2 === 0) {
          const punctuation = arr[idx + 1] || ''
          acc.push(`${part}${punctuation}`)
        }
        return acc
      }, [])
    parts.forEach(pushSegment)
  })
  flush()
  return chunks.filter(Boolean)
}

function ReadableMarkdownText({ text }: { text: string }) {
  const normalized = normalizeEnglishPunctuationSpacing(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  return (
    <div className={`vision-readable-text ${readableParagraphGapClass(text)} prose prose-sm dark:prose-invert max-w-none text-[13px] leading-[1.48] text-neutral-800 dark:text-neutral-200`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={MARKDOWN_COMPONENTS}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeToText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return reactNodeToText(node.props.children)
  return ''
}

function MarkdownCodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copySequenceRef = useRef(0)
  const lang = useContext(VisionLanguageContext)
  const copyFeedback = useContext(VisionCopyFeedbackContext)
  const label = copied
    ? (lang === 'zh' ? '已复制' : 'Copied')
    : (lang === 'zh' ? '复制代码' : 'Copy code')

  useEffect(() => () => {
    copySequenceRef.current += 1
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    copySequenceRef.current += 1
    setCopied(false)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [text])

  const handleCopy = useCallback(async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!text.trim()) return
    const sequence = ++copySequenceRef.current
    const feedbackSequence = copyFeedback?.begin()
    setCopied(false)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const ok = await copyToClipboard(text)
    if (sequence !== copySequenceRef.current) return
    if (feedbackSequence !== undefined && !copyFeedback?.isCurrent(feedbackSequence)) return
    if (!ok) {
      copyFeedback?.reportFailure(lang === 'zh' ? '复制失败，请检查剪贴板权限' : 'Copy failed. Check clipboard permissions.')
      return
    }
    copyFeedback?.clearFailure()
    setCopied(true)
    timerRef.current = window.setTimeout(() => {
      if (sequence === copySequenceRef.current) setCopied(false)
      timerRef.current = null
    }, 1400)
  }, [copyFeedback, lang, text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      onMouseDown={(event) => event.stopPropagation()}
      disabled={!text.trim()}
      title={label}
      aria-label={label}
      data-screenpilot-copy-target="code"
      data-screenpilot-copy-state={copied ? 'copied' : 'idle'}
      className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-neutral-300 opacity-0 ring-1 ring-white/10 backdrop-blur transition hover:bg-white/15 hover:text-white focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
    >
      {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2.1} />}
    </button>
  )
}

type MarkdownPreProps = ComponentPropsWithoutRef<'pre'> & { node?: unknown }

function MarkdownPre(props: MarkdownPreProps) {
  const { children, node, className, ...preProps } = props
  void node
  const text = useMemo(() => reactNodeToText(children).replace(/\n$/, ''), [children])

  return (
    <div className="not-prose group relative my-3 overflow-hidden rounded-xl border border-black/[0.08] bg-neutral-950 text-neutral-100 shadow-sm dark:border-white/[0.08]">
      <MarkdownCodeCopyButton text={text} />
      <pre
        {...preProps}
        className={`m-0 max-h-[360px] overflow-auto p-3.5 pr-12 text-[12px] leading-5 custom-scrollbar ${className ?? ''}`}
      >
        {children}
      </pre>
    </div>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownPre,
}

function markdownFenceState(value: string): { inFence: boolean; displayMathOpen: boolean } {
  let fence: '`' | '~' | null = null
  let displayMathOpen = false

  value.split('\n').forEach(line => {
    const trimmed = line.trim()
    const leading = line.trimStart()
    const fenceMatch = leading.match(/^(```+|~~~+)/)
    if (fenceMatch) {
      const mark = fenceMatch[1][0] as '`' | '~'
      if (!fence) fence = mark
      else if (fence === mark) fence = null
      return
    }
    if (fence) return

    let idx = 0
    while ((idx = trimmed.indexOf('$$', idx)) >= 0) {
      if (idx === 0 || trimmed[idx - 1] !== '\\') displayMathOpen = !displayMathOpen
      idx += 2
    }
  })

  return { inFence: !!fence, displayMathOpen }
}

function isMarkdownBlockLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  return /^#{1,6}\s+/.test(trimmed)
    || /^[-*+]\s+/.test(trimmed)
    || /^\d+[.)]\s+/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^(```+|~~~+)/.test(trimmed)
    || /^-{3,}$/.test(trimmed)
    || /^\|.+\|$/.test(trimmed)
    || /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)
}

function safeStreamingMarkdownBoundary(value: string): number {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let lastBoundary = 0
  let lineStart = 0
  let previousLine = ''

  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] !== '\n') continue
    const line = normalized.slice(lineStart, i)
    const nextLineStart = i + 1
    const prefix = normalized.slice(0, nextLineStart)
    const { inFence, displayMathOpen } = markdownFenceState(prefix)
    if (!inFence && !displayMathOpen) {
      const isBlankBoundary = !line.trim()
      const isBlockBoundary = isMarkdownBlockLine(line) || isMarkdownBlockLine(previousLine)
      const hasParagraphGap = normalized.slice(Math.max(0, i - 1), i + 1) === '\n\n'
      if (isBlankBoundary || isBlockBoundary || hasParagraphGap) {
        lastBoundary = nextLineStart
      }
    }
    previousLine = line
    lineStart = nextLineStart
  }

  return lastBoundary
}

function splitStreamingMarkdown(value: string): { stable: string; tail: string } {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const boundary = safeStreamingMarkdownBoundary(normalized)
  if (boundary <= 0) return { stable: '', tail: normalized }
  return {
    stable: normalized.slice(0, boundary).trimEnd(),
    tail: normalized.slice(boundary).replace(/^\n+/, ''),
  }
}

const StableMarkdownText = memo(function StableMarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={MARKDOWN_COMPONENTS}>
      {text}
    </ReactMarkdown>
  )
})

function StreamingMarkdownText({ text, active }: { text: string; active: boolean }) {
  const { stable, tail } = useMemo(
    () => active ? splitStreamingMarkdown(text) : { stable: text, tail: '' },
    [active, text],
  )

  if (!stable.trim()) {
    return (
      <div className="not-prose whitespace-pre-wrap break-words text-[13.5px] leading-7 text-neutral-800 dark:text-neutral-200">
        {tail}
      </div>
    )
  }

  return (
    <>
      <StableMarkdownText text={stable} />
      {tail && (
        <div className="not-prose mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-7 text-neutral-800 dark:text-neutral-200">
          {tail}
        </div>
      )}
    </>
  )
}

function ReadonlyOcrMarkdownText({ text }: { text: string }) {
  return (
    <div
      data-screenpilot-ocr-source-content="true"
      className={`ocr-markdown vision-readable-text ${readableParagraphGapClass(text)} prose prose-sm dark:prose-invert max-w-none text-[13px] leading-[1.48] text-neutral-800 dark:text-neutral-200 select-text`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function EditableOcrText({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef(value)
  const composingRef = useRef(false)
  const userEditedRef = useRef(false)
  const suppressInputRef = useRef(false)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (value === lastEmittedRef.current) return
    suppressInputRef.current = true
    root.innerHTML = editableOcrHtml(value)
    lastEmittedRef.current = readEditableOcrText(root)
    queueMicrotask(() => { suppressInputRef.current = false })
  }, [value])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    suppressInputRef.current = true
    root.innerHTML = editableOcrHtml(value)
    lastEmittedRef.current = readEditableOcrText(root)
    queueMicrotask(() => { suppressInputRef.current = false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = useCallback(() => {
    if (suppressInputRef.current) return
    if (composingRef.current) return
    const root = rootRef.current
    if (!root) return
    const next = readEditableOcrText(root)
    if (next === lastEmittedRef.current) return
    lastEmittedRef.current = next
    onChange(next)
  }, [onChange])

  const handleInput = useCallback(() => {
    userEditedRef.current = true
    emit()
  }, [emit])

  const handleBlur = useCallback(() => {
    if (!userEditedRef.current) return
    emit()
    userEditedRef.current = false
  }, [emit])

  const handlePaste = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    userEditedRef.current = true
    document.execCommand('insertText', false, text)
    requestAnimationFrame(emit)
  }, [emit])

  return (
    <div
      ref={rootRef}
      data-screenpilot-ocr-source-content="true"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={handleInput}
      onBlur={handleBlur}
      onPaste={handlePaste}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => {
        composingRef.current = false
        userEditedRef.current = true
        emit()
      }}
      className={`ocr-editable vision-readable-text ${readableParagraphGapClass(value)} prose prose-sm dark:prose-invert max-w-none text-[13px] leading-[1.48] text-neutral-800 dark:text-neutral-200 custom-scrollbar`}
    />
  )
}

type Point = { x: number; y: number }
type Rect = { x: number; y: number; width: number; height: number }
type BarRect = { x: number; y: number; width: number }
type CopyTarget = 'answer' | 'original' | 'translated'
type Arrow = {
  x1: number
  y1: number
  x2: number
  y2: number
}

const ARROW_COLOR = '#ff3b30'
const ARROW_MIN_DRAG_PX = 8
const ARROW_HEAD_ANGLE_DEG = 30
/** 纯文字会话的历史 id。前缀便于排查；字符集刻意只用字母数字和连字符，
    保证即便误传到后端也能过 is_safe_image_id 的校验。 */
function makeTextSessionId(): string {
  return `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const HISTORY_THUMB_SIZE = 96     // 历史记录缩略图边长（px），原始截图压成这个尺寸再持久化
const HISTORY_PANEL_W = 240
const HISTORY_PANEL_MAX_H = 200
const HISTORY_PANEL_MIN_H = 56
const HISTORY_PANEL_GAP = 8
const PROMPT_PREVIEW_GAP = 8
/**
 * 预览卡整体高度上限（逻辑 px）。
 * 悬浮态是先按 `READY_BAR_H + GAP + 这个值` 预留窗口高度并据此夹取 Y 位置，
 * 之后才实测卡片真实高度。所以卡片必须硬性不超过这个值 —— 否则窗口会向下长出
 * 屏幕（按钮被任务栏盖住点不到），因为 resize 不会重新夹一次位置。
 */
const PROMPT_PREVIEW_MAX_H = 360
/** 卡片里除「优化后」文本域之外的固定部分（原文段 + 两个标题 + 按钮行 + 内边距）。 */
const PROMPT_PREVIEW_CHROME_H = 210
const HISTORY_BUTTON_ESTIMATED_H = 36

const READY_BAR_H = 56            // 对话栏单行高度（与字号绑定，不随屏幕变）
const ANCHOR_GAP = 12              // 对话栏与选区之间的水平间距
const DRAG_THRESHOLD = 5
const SELECT_MASK_COLOR = 'rgba(0, 0, 0, 0.118)'
const SHAREX_REGION_ANIMATION_MS = 200
function findWindowAt(windows: VisionWindowInfo[], gp: Point): VisionWindowInfo | null {
  for (const w of windows) {
    if (gp.x >= w.x && gp.x < w.x + w.width && gp.y >= w.y && gp.y < w.y + w.height) {
      return w
    }
  }
  return null
}

function lerpNumber(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    x: lerpNumber(from.x, to.x, t),
    y: lerpNumber(from.y, to.y, t),
    width: lerpNumber(from.width, to.width, t),
    height: lerpNumber(from.height, to.height, t),
  }
}

function rectEquals(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function clampRect(rect: Rect | null, viewport: { w: number; h: number }): Rect | null {
  if (!rect) return null
  const x = Math.max(0, Math.min(viewport.w, rect.x))
  const y = Math.max(0, Math.min(viewport.h, rect.y))
  const right = Math.max(x, Math.min(viewport.w, rect.x + rect.width))
  const bottom = Math.max(y, Math.min(viewport.h, rect.y + rect.height))
  const width = right - x
  const height = bottom - y
  if (width < 1 || height < 1) return null
  return { x, y, width, height }
}

function inflateRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  }
}

function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let left = rects[0].x
  let top = rects[0].y
  let right = rects[0].x + rects[0].width
  let bottom = rects[0].y + rects[0].height
  for (const rect of rects.slice(1)) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function domRectToRect(rect: DOMRect): Rect | null {
  if (rect.width < 1 || rect.height < 1) return null
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

const TRANSITION_MS = 380
const NATIVE_FLOATING_FLY_MS = 260
const JELLY_DURATION_MS = 420
const SELECT_BAR_COLLAPSE_MS = 120
const FLOATING_PADDING = VISION_FLOATING_PADDING
const FLOATING_GAP = 8
const HIT_REGION_MARGIN = 2
const CHAT_AUTO_FOLLOW_THRESHOLD_PX = 48

function isChatAtLiveEdge(el: HTMLDivElement, order: 'asc' | 'desc'): boolean {
  if (order === 'desc') return el.scrollTop <= CHAT_AUTO_FOLLOW_THRESHOLD_PX
  return el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_AUTO_FOLLOW_THRESHOLD_PX
}

function scrollChatToLiveEdge(el: HTMLDivElement, order: 'asc' | 'desc') {
  if (order === 'desc') el.scrollTop = 0
  else el.scrollTop = el.scrollHeight
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : trimmed
}

function extractOptimizedPromptForInput(value: string): string {
  const text = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!text) return ''

  const lines = text.split('\n')
  const start = lines.findIndex(line => {
    const title = line.trim().replace(/^#{1,6}\s*/, '').replace(/[:：]\s*$/, '').trim()
    return /^(优化后的提示词|Optimized Prompt)(\s*[:：].*)?$/i.test(title)
  })
  if (start < 0) return stripMarkdownFence(text)

  const inline = lines[start]
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(优化后的提示词|Optimized Prompt)\s*[:：]?\s*/i, '')
    .trim()
  const section = inline ? [inline, ...lines.slice(start + 1)] : lines.slice(start + 1)
  const end = section.findIndex(line => {
    const title = line.trim().replace(/^#{1,6}\s*/, '').replace(/[:：]\s*$/, '').trim()
    return /^(调整要点|Changes Made)$/i.test(title) || /^#{1,6}\s+/.test(line.trim())
  })
  const extracted = (end >= 0 ? section.slice(0, end) : section).join('\n').trim()
  return stripMarkdownFence(extracted || text)
}

async function makeThumbnail(dataUrl: string, maxSize: number): Promise<string> {
  if (!dataUrl) return ''
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1)
      const w = Math.max(1, Math.round(img.width * ratio))
      const h = Math.max(1, Math.round(img.height * ratio))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(dataUrl); return }
      ctx.drawImage(img, 0, 0, w, h)
      try { resolve(canvas.toDataURL('image/jpeg', 0.7)) }
      catch { resolve(dataUrl) }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function drawArrow(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineWidth: number,
) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len < 1) return

  const headSize = lineWidth * 4
  const angle = Math.atan2(dy, dx)
  const headAngle = (ARROW_HEAD_ANGLE_DEG * Math.PI) / 180

  const shaftEndX = x2 - Math.cos(angle) * (headSize * 0.6)
  const shaftEndY = y2 - Math.sin(angle) * (headSize * 0.6)

  ctx.save()
  ctx.strokeStyle = ARROW_COLOR
  ctx.fillStyle = ARROW_COLOR
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(shaftEndX, shaftEndY)
  ctx.stroke()

  const wing1X = x2 - Math.cos(angle - headAngle) * headSize
  const wing1Y = y2 - Math.sin(angle - headAngle) * headSize
  const wing2X = x2 - Math.cos(angle + headAngle) * headSize
  const wing2Y = y2 - Math.sin(angle + headAngle) * headSize
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(wing1X, wing1Y)
  ctx.lineTo(wing2X, wing2Y)
  ctx.closePath()
  ctx.fill()

  ctx.restore()
}

async function composeAnnotatedImage(
  imageDataUrl: string,
  arrows: Arrow[],
  frameWidth: number,
  frameHeight: number,
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('failed to load image for compose'))
    el.src = imageDataUrl
  })

  const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable')

  ctx.drawImage(img, 0, 0)

  const scaleX = frameWidth > 0 ? img.naturalWidth / frameWidth : 1
  const scaleY = frameHeight > 0 ? img.naturalHeight / frameHeight : 1
  const lineWidth = Math.max(3, img.naturalWidth / 400)

  for (const a of arrows) {
    drawArrow(
      ctx,
      a.x1 * scaleX,
      a.y1 * scaleY,
      a.x2 * scaleX,
      a.y2 * scaleY,
      lineWidth,
    )
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const buf = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function ArrowSvg({ arrow }: { arrow: Arrow }) {
  const { x1, y1, x2, y2 } = arrow
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len < 1) return null

  const lineWidth = 4
  const headSize = lineWidth * 4
  const angle = Math.atan2(dy, dx)
  const headAngle = (ARROW_HEAD_ANGLE_DEG * Math.PI) / 180

  const shaftEndX = x2 - Math.cos(angle) * (headSize * 0.6)
  const shaftEndY = y2 - Math.sin(angle) * (headSize * 0.6)
  const wing1X = x2 - Math.cos(angle - headAngle) * headSize
  const wing1Y = y2 - Math.sin(angle - headAngle) * headSize
  const wing2X = x2 - Math.cos(angle + headAngle) * headSize
  const wing2Y = y2 - Math.sin(angle + headAngle) * headSize

  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={shaftEndX}
        y2={shaftEndY}
        stroke={ARROW_COLOR}
        strokeWidth={lineWidth}
        strokeLinecap="round"
      />
      <polygon
        points={`${x2},${y2} ${wing1X},${wing1Y} ${wing2X},${wing2Y}`}
        fill={ARROW_COLOR}
      />
    </g>
  )
}

type Metrics = {
  READY_W: number
  SELECT_W: number
  ANSWER_H: number
  SELECT_BOTTOM_OFFSET: number
}

const computeMetrics = (vw: number, vh: number): Metrics => ({
  READY_W: Math.round(Math.max(420, Math.min(720, vw * 0.42))),
  SELECT_W: Math.round(Math.max(480, Math.min(820, vw * 0.5))),
  ANSWER_H: Math.round(Math.max(220, Math.min(480, vh * 0.45))),
  SELECT_BOTTOM_OFFSET: Math.round(Math.max(80, Math.min(160, vh * 0.13))),
})

const computeSelectBar = (vw: number, vh: number, m: Metrics): BarRect => ({
  x: Math.round(vw / 2 - m.SELECT_W / 2),
  y: Math.round(vh - m.SELECT_BOTTOM_OFFSET - READY_BAR_H),
  width: m.SELECT_W,
})

/**
 * 纯文字场景下输入条飞过去的落点：水平居中、顶边落在屏幕高度的 22%。
 * 22% 是 Spotlight / Raycast 这类启动器的常规位置 —— 视线自然落点偏上，
 * 且下方留足空间给随后展开的回答面板 / 优化卡，不至于贴着屏幕底边。
 * 宽度由调用方保持不变，这里只算位置。
 */
const TOP_SLOT_RATIO = 0.22
const TOP_SLOT_MIN_Y = 48

const computeTopSlot = (vw: number, vh: number, barW: number) => ({
  x: Math.round(vw / 2 - barW / 2),
  y: Math.round(Math.max(TOP_SLOT_MIN_Y, vh * TOP_SLOT_RATIO)),
})

function estimateTokens(text: string): number {
  let ascii = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
  }
  const nonAscii = text.length - ascii
  return Math.ceil(ascii / 4 + nonAscii)
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function ThinkingBlock({
  reasoning,
  active,
  thinkingLabel,
  thoughtLabel,
}: {
  reasoning: string
  active: boolean
  thinkingLabel: string
  thoughtLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [finalDurationMs, setFinalDurationMs] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const bodyId = useId()
  const startRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active && startRef.current === null) {
      startRef.current = Date.now()
      setFinalDurationMs(null)
    } else if (!active && startRef.current !== null) {
      setFinalDurationMs(Date.now() - startRef.current)
      startRef.current = null
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])

  useEffect(() => {
    if (open && active && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [reasoning, active, open])

  const elapsedMs = active && startRef.current
    ? now - startRef.current
    : finalDurationMs
  const seconds = elapsedMs !== null ? Math.max(1, Math.round(elapsedMs / 1000)) : null
  // O(n) 字符遍历，按 reasoning 长度记忆 — 避免多轮 history 中每次 delta 重渲全部 ThinkingBlock 都重算
  const tokens = useMemo(() => formatTokens(estimateTokens(reasoning)), [reasoning])

  return (
    <div className="not-prose mb-2 rounded-lg border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.025] dark:bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
      >
        {active
          ? <Loader2 className="animate-spin" size={11} />
          : <Brain size={11} strokeWidth={1.75} />}
        <span className="font-medium">{active ? thinkingLabel : thoughtLabel}</span>
        <span className="text-neutral-400 dark:text-neutral-500">
          {seconds !== null && <> · {seconds}s</>}
          <> · ~{tokens} tokens</>
        </span>
        <ChevronDown size={11} strokeWidth={2} className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div
        id={bodyId}
        ref={bodyRef}
        hidden={!open}
        className="px-2.5 pb-2 max-h-[160px] overflow-y-auto custom-scrollbar text-[11.5px] leading-5 text-neutral-500 dark:text-neutral-400 italic whitespace-pre-wrap break-words"
      >
        {reasoning}
      </div>
    </div>
  )
}

function ShareXSelectionFrame({ rect, animated = true }: { rect: Rect; animated?: boolean }) {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const x = 0.5
  const y = 0.5
  const w = Math.max(0, width - 1)
  const h = Math.max(0, height - 1)

  return (
    <svg
      className="absolute pointer-events-none overflow-visible"
      style={{ left: rect.x, top: rect.y, width, height, zIndex: 8 }}
      width={width}
      height={height}
      shapeRendering="crispEdges"
    >
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="black" strokeWidth={1} />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke="white"
        strokeWidth={1}
        strokeDasharray="5 5"
        className={animated ? 'sharex-selection-dash' : undefined}
      />
    </svg>
  )
}

function ShareXInfoLabel({ rect, text, viewport }: { rect: Rect; text: string; viewport: { w: number; h: number } }) {
  const estimatedWidth = Math.max(72, text.length * 7 + 12)
  const estimatedHeight = 22
  const gap = 6
  const padding = 3
  const x = Math.max(0, Math.min(viewport.w - estimatedWidth - padding, rect.x + padding))
  const y = rect.y - gap - estimatedHeight >= 0
    ? rect.y - gap - estimatedHeight
    : Math.min(viewport.h - estimatedHeight - padding, rect.y + gap + padding)

  return (
    <div
      className="absolute pointer-events-none whitespace-nowrap font-[Verdana] text-[11px] leading-[16px] text-white"
      style={{
        left: x,
        top: Math.max(0, y),
        padding: '2px 3px',
        backgroundColor: 'rgba(0, 0, 0, 0.47)',
        border: '1px solid rgba(255, 255, 255, 0.59)',
        boxShadow: 'inset 0 0 0 1px rgba(0, 81, 145, 0.59), 1px 1px 0 rgba(0, 0, 0, 0.75)',
        textShadow: '1px 1px 0 #000',
        zIndex: 9,
      }}
    >
      {text}
    </div>
  )
}

export default function Vision() {
  const [stage, setStage] = useState<Stage>('select')
  const [windows, setWindows] = useState<VisionWindowInfo[]>([])
  const [hovered, setHovered] = useState<VisionWindowInfo | null>(null)
  const [winOrigin, setWinOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dragStart, setDragStart] = useState<Point | null>(null)
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null)
  const [dragging, setDragging] = useState(false)
  const [keyboardSelectionMode, setKeyboardSelectionMode] = useState<'window' | 'region' | null>(null)
  const [keyboardRegion, setKeyboardRegion] = useState<Rect | null>(null)
  const [a11yAnnouncement, setA11yAnnouncement] = useState('')
  const [selectBarCollapsed, setSelectBarCollapsed] = useState(false)
  const [animatedHoverRect, setAnimatedHoverRect] = useState<Rect | null>(null)
  const [imagePreview, setImagePreview] = useState('')
  const [appLabel, setAppLabel] = useState('')
  const [input, setInput] = useState('')
  // Vision 启动前 Rust 端抓到的选中文本：作为本次会话的上下文前缀
  // 仅在首轮 chat 消息发送时拼接进 prompt；徽章静态显示行数；次轮不再注入。
  const [selectionText, setSelectionText] = useState('')
  const [messages, setMessages] = useState<ExplainMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [promptOptimizing, setPromptOptimizing] = useState(false)
  // 提示词优化预览卡：原文永远留在 input 里不动，优化结果先进这张卡，
  // 用户「采纳」才写回输入框。status 决定卡片显示骨架 / 结果 / 错误。
  const [promptPreviewStatus, setPromptPreviewStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [promptPreviewSource, setPromptPreviewSource] = useState('')
  const [promptPreviewText, setPromptPreviewText] = useState('')
  const [promptPreviewCardHeight, setPromptPreviewCardHeight] = useState<number | null>(null)
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null)
  const [copyErrorAnnouncement, setCopyErrorAnnouncement] = useState('')
  const [speechLoadingTarget, setSpeechLoadingTarget] = useState<SpeechTarget | null>(null)
  const [speakingTarget, setSpeakingTarget] = useState<SpeechTarget | null>(null)
  const [speechErrorTarget, setSpeechErrorTarget] = useState<SpeechTarget | null>(null)
  const [speechErrorAnnouncement, setSpeechErrorAnnouncement] = useState('')
  const [lang, setLang] = useState<Lang>('zh')
  const [activeVisionModel, setActiveVisionModel] = useState('AI')
  const [messageOrder, setMessageOrder] = useState<'asc' | 'desc'>('asc')
  const [keepFullscreen, setKeepFullscreen] = useState(true)
  const [floatingRebased, setFloatingRebased] = useState(false)
  const [mode, setMode] = useState<Mode>(() => readModeFromHash())
  const [translateOriginal, setTranslateOriginal] = useState('')
  const [translateOriginalError, setTranslateOriginalError] = useState('')
  const [translateText, setTranslateText] = useState('')
  const [translateError, setTranslateError] = useState('')
  const [translateDurationMs, setTranslateDurationMs] = useState<number | null>(null)
  const [captureWarning, setCaptureWarning] = useState('')
  const [streamListenerError, setStreamListenerError] = useState<'answer' | 'translate' | null>(null)
  const [closeFailed, setCloseFailed] = useState(false)
  const [showTranslateOriginal, setShowTranslateOriginal] = useState(true)
  const [translateRetranslating, setTranslateRetranslating] = useState(false)
  const [translateOcrMethod, setTranslateOcrMethod] = useState<ScreenshotOcrMethod>('ai')
  const [translateMethod, setTranslateMethod] = useState<ScreenshotTranslationMethod>('ai')
  const [ocrMethodSwitching, setOcrMethodSwitching] = useState(false)
  const [translationMethodSwitching, setTranslationMethodSwitching] = useState(false)
  const [translateNow, setTranslateNow] = useState(() => Date.now())
  const translateStartRef = useRef<number | null>(null)
  const translateEditDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const translateEditSeqRef = useRef(0)
  const translateOriginalEditedRef = useRef(false)
  const ignoreTranslateStreamRef = useRef(false)
  const showTranslateOriginalRef = useRef(true)
  const translateOriginalRef = useRef('')
  const translateTextRef = useRef('')
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }))
  const metrics = useMemo(() => computeMetrics(viewport.w, viewport.h), [viewport])
  const [barRect, setBarRect] = useState<BarRect>(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1280
    const h = typeof window !== 'undefined' ? window.innerHeight : 800
    return computeSelectBar(w, h, computeMetrics(w, h))
  })
  const [barIntro, setBarIntro] = useState(true)
  // barNoTransition：reset 时临时禁用 left/top/width transition，避免上次 ready/answering 位置
  // 残留的 380ms 动画在 window hide 时被暂停，下次 show 时从中间帧续播 → 视觉上 bar
  // 从老位置"滑"回 select 默认位置的闪烁。
  const [barNoTransition, setBarNoTransition] = useState(false)
  const [barFlyOffset, setBarFlyOffset] = useState<Point>({ x: 0, y: 0 })
  const [barRebaseHidden, setBarRebaseHidden] = useState(false)
  // 截图后输入栏会从 select 位置飞到截图附近。Windows 原生命中裁剪不能在动画中裁得太紧，
  // 否则 WebView 会把正在飞行的卡片裁掉。
  const [barInFlight, setBarInFlight] = useState(false)
  const [jellyActive, setJellyActive] = useState(false)
  const [capturedFrame, setCapturedFrame] = useState<CapturedFrame | null>(null)
  // 箭头标注:仅 stage==='ready' 子模式
  // arrows / draftArrow 坐标系 = capturedFrame 逻辑像素 (左上角为原点)
  const [drawMode, setDrawMode] = useState(false)
  const [arrows, setArrows] = useState<Arrow[]>([])
  const [draftArrow, setDraftArrow] = useState<Arrow | null>(null)
  // 任何 stage 切换时强制清掉 draw 子模式 + 已落箭头
  useEffect(() => {
    if (stage !== 'ready') {
      setDrawMode(false)
      setArrows([])
      setDraftArrow(null)
    }
  }, [stage])
  const initialHistoryRef = useRef<VisionHistoryLoadResult | null>(null)
  if (initialHistoryRef.current === null) initialHistoryRef.current = loadVisionHistory(localStorage)
  const [history, setHistory] = useState<HistoryItem[]>(initialHistoryRef.current.items)
  const historyRejectedCount = initialHistoryRef.current.rejectedCount
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hitRegionRect, setHitRegionRect] = useState<Rect | null>(null)
  const [nativeHitRegionActive, setNativeHitRegionActive] = useState(false)
  const [panelDragActive, setPanelDragActive] = useState(false)
  const [windowMoveRevision, setWindowMoveRevision] = useState(0)

  useEffect(() => {
    if (historyRejectedCount <= 0) return
    const timer = window.setTimeout(() => {
      try {
        localStorage.removeItem(VISION_HISTORY_REPAIR_NOTICE_KEY)
      } catch {
        // A stale notice is harmless and can be retried on the next open.
      }
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [historyRejectedCount])

  const inputRef = useRef<HTMLInputElement>(null)
  const barPanelRef = useRef<HTMLDivElement>(null)
  const answerPanelRef = useRef<HTMLDivElement>(null)
  const translateCardRef = useRef<HTMLDivElement>(null)
  const promptPreviewCardRef = useRef<HTMLDivElement>(null)
  const promptPreviewEditorRef = useRef<HTMLTextAreaElement>(null)
  const historyPanelRef = useRef<HTMLDivElement>(null)
  const historyDropdownRef = useRef<HTMLDivElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const drawSurfaceRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Stage>('select')
  const modeRef = useRef<Mode>(mode)
  const historyOpenRef = useRef(false)
  const imageIdRef = useRef('')
  const hasScreenshot = !!imageIdRef.current
  // 纯文字会话的会话 id。多轮对话要落到同一条历史上，所以第一次入库时生成、
  // 之后一直沿用，直到 enterSelect / resetBeforeHide 开启新会话。
  const textSessionIdRef = useRef('')
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copySequenceRef = useRef(0)
  const copiedTextRef = useRef<{ target: CopyTarget; text: string } | null>(null)
  const messagesRef = useRef<ExplainMessage[]>([])
  const captureWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const historyPersistenceRef = useRef<Set<Promise<void>>>(new Set())
  const speechAudioRef = useRef<HTMLAudioElement | null>(null)
  const speechSeqRef = useRef(0)
  const nativeFlySeqRef = useRef(0)
  const barFlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const jellyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusReqIdRef = useRef(0)
  const prevStreamingRef = useRef(false)
  const visionStreamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visionStreamBufferRef = useRef({ content: '', reasoning: '' })
  const visionStreamListenerReadyRef = useRef(false)
  const translateStreamListenerReadyRef = useRef(false)
  const retryVisionStreamListenerRef = useRef<() => Promise<boolean>>(async () => false)
  const retryTranslateStreamListenerRef = useRef<() => Promise<boolean>>(async () => false)
  const visionStreamEnabledRef = useRef(true)
  const closePendingRef = useRef(false)
  const preparingSendRef = useRef(false)
  const visionRequestLifecycleRef = useRef(new VisionRequestLifecycle())
  const visionTerminalErrorRef = useRef<{ requestId: string; error: string; incompleteReason?: string } | null>(null)
  const closingStreamRef = useRef(false)
  const closeResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatAutoFollowRef = useRef(true)
  const promptOptimizeSeqRef = useRef(0)
  // Stream 真实结束（成功 / 错误 / 用户主动取消）后才置 true，
  // 让历史持久化 effect 只在这一次 rerun 触发 push；restoreHistory / enterSelect / resetBeforeHide 防御性清零，
  // 避免恢复历史时 setMessages 触发 effect 把恢复的对话又当新条目写一遍历史。
  const justFinishedStreamRef = useRef(false)
  // capture 期间 macOS screencapture 可能短暂让 vision webview 失焦 → 触发 blur 误关闭。
  // 这个 ref 标记"截图进行中"，blur handler 看到就跳过。
  const capturingRef = useRef(false)
  // Capture IPC can finish after the Vision surface has already been closed or
  // replaced. Keep it separate from the AI request lifecycle: a stale capture
  // must never restore the hidden surface, and any late temporary image must be
  // released instead of being adopted by the next Vision session.
  const captureSequenceRef = useRef(0)
  const captureSurfaceActiveRef = useRef(false)
  const visionSurfaceEpochRef = useRef(0)
  // selectionText 异步 take 的重入 token：每次 enterSelect / resetBeforeHide / restoreHistory 都 +1，
  // 老请求看到 myReq !== current 直接丢弃，避免 take 完成时已经进入新会话被错误注入。
  const selectionReqIdRef = useRef(0)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  // 浮动模式下保存截图时的全屏 metrics，避免窗口缩小后 answerLayout 被压缩得太小
  const fullscreenMetricsRef = useRef<Metrics | null>(null)
  const hoverAnimationRef = useRef<{ rect: Rect | null; raf: number | null }>({ rect: null, raf: null })
  const floatingSizeRef = useRef<{ width: number; height: number; hasScreenshot: boolean } | null>(null)
  const cursorPassthroughRef = useRef(false)
  const panelDraggingRef = useRef(false)

  const t = i18n[lang]
  stageRef.current = stage
  modeRef.current = mode
  historyOpenRef.current = historyOpen
  showTranslateOriginalRef.current = showTranslateOriginal
  translateOriginalRef.current = translateOriginal
  translateTextRef.current = translateText
  messagesRef.current = messages

  const ensureVisionStreamListener = useCallback(async () => {
    if (!visionStreamEnabledRef.current || visionStreamListenerReadyRef.current) return true
    const ready = await retryVisionStreamListenerRef.current()
    if (!ready) setStreamListenerError('answer')
    return ready
  }, [])

  const ensureTranslateStreamListener = useCallback(async () => {
    if (translateStreamListenerReadyRef.current) return true
    const ready = await retryTranslateStreamListenerRef.current()
    if (!ready) setStreamListenerError('translate')
    return ready
  }, [])

  const clearCopyFailure = useCallback(() => {
    if (copyErrorTimeoutRef.current) clearTimeout(copyErrorTimeoutRef.current)
    copyErrorTimeoutRef.current = null
    setCopyErrorAnnouncement('')
  }, [])

  const reportCopyFailure = useCallback((message: string) => {
    clearCopyFailure()
    setCopyErrorAnnouncement(message)
    copyErrorTimeoutRef.current = window.setTimeout(() => {
      setCopyErrorAnnouncement('')
      copyErrorTimeoutRef.current = null
    }, 2500)
  }, [clearCopyFailure])

  const beginCopyOperation = useCallback(() => {
    copySequenceRef.current += 1
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = null
    }
    setCopiedTarget(null)
    copiedTextRef.current = null
    clearCopyFailure()
    return copySequenceRef.current
  }, [clearCopyFailure])

  const copyOperationIsCurrent = useCallback((sequence: number) => (
    sequence === copySequenceRef.current
  ), [])

  const copyFeedback = useMemo<VisionCopyFeedback>(() => ({
    begin: beginCopyOperation,
    isCurrent: copyOperationIsCurrent,
    clearFailure: clearCopyFailure,
    reportFailure: reportCopyFailure,
  }), [beginCopyOperation, clearCopyFailure, copyOperationIsCurrent, reportCopyFailure])

  const latestAssistantText = useMemo(() => (
    [...messages].reverse().find(message => message.role === 'assistant' && message.content)?.content ?? ''
  ), [messages])
  useEffect(() => {
    if (
      copiedTarget !== 'answer'
      || copiedTextRef.current?.target !== 'answer'
    ) return
    if (copiedTextRef.current.text !== latestAssistantText) beginCopyOperation()
  }, [beginCopyOperation, copiedTarget, latestAssistantText])
  useEffect(() => {
    if (
      copiedTarget !== 'original'
      || copiedTextRef.current?.target !== 'original'
    ) return
    if (copiedTextRef.current.text !== translateOriginal) beginCopyOperation()
  }, [beginCopyOperation, copiedTarget, translateOriginal])
  useEffect(() => {
    if (
      copiedTarget !== 'translated'
      || copiedTextRef.current?.target !== 'translated'
    ) return
    if (copiedTextRef.current.text !== translateText) beginCopyOperation()
  }, [beginCopyOperation, copiedTarget, translateText])

  const invalidateVisionRequest = useCallback(() => {
    const sequence = visionRequestLifecycleRef.current.invalidate()
    visionTerminalErrorRef.current = null
    preparingSendRef.current = false
    nativeFlySeqRef.current++
    return sequence
  }, [])

  const invalidateCapture = useCallback(() => {
    captureSequenceRef.current += 1
    captureSurfaceActiveRef.current = false
    capturingRef.current = false
  }, [])

  const invalidateVisionSurface = useCallback(() => {
    visionSurfaceEpochRef.current += 1
    invalidateCapture()
    selectionReqIdRef.current += 1
    nativeFlySeqRef.current += 1
    focusReqIdRef.current += 1
  }, [invalidateCapture])

  const captureResultIsCurrent = useCallback(async (sequence: number) => {
    if (
      sequence !== captureSequenceRef.current
      || !captureSurfaceActiveRef.current
    ) return false
    try {
      const visible = await getCurrentWindow().isVisible()
      return visible
        && sequence === captureSequenceRef.current
        && captureSurfaceActiveRef.current
    } catch (error) {
      console.error('[vision-capture] window visibility check failed:', error)
      return false
    }
  }, [])

  const deleteStaleCaptureImage = useCallback(async (imageId?: string) => {
    if (!imageId) return
    try {
      await api.visionDeleteTemporaryImage(imageId)
    } catch (error) {
      console.error('[vision-capture] stale image cleanup failed:', error)
    }
  }, [])

  const showArchiveWarning = useCallback((warning?: string) => {
    if (!warning) return
    const detail = warning.replace(/^Screenshot archive failed:\s*/i, '')
    setCaptureWarning(`${i18n[lang].visionArchiveWarning}${lang === 'zh' ? '：' : ': '}${detail}`)
    if (captureWarningTimeoutRef.current) clearTimeout(captureWarningTimeoutRef.current)
    captureWarningTimeoutRef.current = window.setTimeout(() => {
      captureWarningTimeoutRef.current = null
      setCaptureWarning('')
    }, 6000)
  }, [lang])

  const isVisionRequestCurrent = useCallback((requestId: string) => (
    visionRequestLifecycleRef.current.isCurrent(requestId)
  ), [])

  const cancelPromptOptimization = useCallback(() => {
    promptOptimizeSeqRef.current += 1
    setPromptOptimizing(false)
    setPromptPreviewStatus('idle')
    setPromptPreviewSource('')
    setPromptPreviewText('')
  }, [])


  const stopSpeechPlayback = useCallback(() => {
    speechSeqRef.current += 1
    const audio = speechAudioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    speechAudioRef.current = null
    setSpeechLoadingTarget(null)
    setSpeakingTarget(null)
    setSpeechErrorTarget(null)
    setSpeechErrorAnnouncement('')
  }, [])

  const setVisionCursorPassthrough = useCallback((ignore: boolean) => {
    if (cursorPassthroughRef.current === ignore) return
    cursorPassthroughRef.current = ignore
    void api.visionSetIgnoreCursorEvents(ignore).catch(err => {
      cursorPassthroughRef.current = !ignore
      console.error('[vision-floating] cursor passthrough failed:', err)
    })
  }, [])

  const clearVisionStreamFlushTimer = useCallback(() => {
    if (visionStreamFlushTimerRef.current) {
      clearTimeout(visionStreamFlushTimerRef.current)
      visionStreamFlushTimerRef.current = null
    }
  }, [])

  const flushVisionStreamBuffer = useCallback((sync = false) => {
    const pending = visionStreamBufferRef.current
    if (!pending.content && !pending.reasoning) return
    visionStreamBufferRef.current = { content: '', reasoning: '' }

    const applyBufferedMessages = () => {
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant') return prev
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            content: last.content + pending.content,
            reasoning: pending.reasoning ? (last.reasoning ?? '') + pending.reasoning : last.reasoning,
          },
        ]
      })
    }

    if (sync) flushSync(applyBufferedMessages)
    else applyBufferedMessages()
  }, [])

  const resetVisionStreamBuffer = useCallback(() => {
    clearVisionStreamFlushTimer()
    visionStreamBufferRef.current = { content: '', reasoning: '' }
  }, [clearVisionStreamFlushTimer])

  const scheduleVisionStreamFlush = useCallback(() => {
    if (visionStreamFlushTimerRef.current) return
    visionStreamFlushTimerRef.current = window.setTimeout(() => {
      visionStreamFlushTimerRef.current = null
      flushVisionStreamBuffer()
    }, 48)
  }, [flushVisionStreamBuffer])

  const selectionLineCount = useMemo(() => {
    if (mode !== 'chat') return 0
    if (!selectionText.trim()) return 0
    return selectionText.split(/\r?\n/).length
  }, [selectionText, mode])

  useEffect(() => {
    void (async () => {
      try {
        const settings = await api.getSettings()
        setLang((settings.settingsLanguage as Lang) || 'zh')
        setActiveVisionModel(resolveVisionModelLabel(settings))
        visionStreamEnabledRef.current = settings.vision?.streamEnabled !== false
        setMessageOrder(settings.vision?.messageOrder === 'desc' ? 'desc' : 'asc')
        const curMode = readModeFromHash()
        const cfg = curMode === 'translate' ? settings.screenshotTranslation : settings.vision
        setKeepFullscreen(cfg?.keepFullscreenAfterCapture !== false)
        if (curMode === 'translate') {
          setShowTranslateOriginal(!(settings.screenshotTranslation?.directTranslate ?? false))
          setTranslateOcrMethod(resolveScreenshotOcrMethod(settings))
          setTranslateMethod(resolveScreenshotTranslationMethod(settings))
        }
      } catch (err) { console.error('Failed to load settings', err) }
    })()
  }, [])

  const focusVisionInput = useCallback((delays: number[] = [0, 40, 120, 240, 420]) => {
    if (historyOpenRef.current) {
      focusReqIdRef.current += 1
      return
    }
    const requestId = ++focusReqIdRef.current
    const canFocus = () => (
      requestId === focusReqIdRef.current
      && modeRef.current === 'chat'
      && !historyOpenRef.current
      && !capturingRef.current
      && (stageRef.current === 'select' || stageRef.current === 'ready' || stageRef.current === 'answering')
    )

    const run = async () => {
      if (!canFocus()) return
      try {
        await getCurrentWindow().setFocus()
      } catch {
        // Native focus can fail briefly while the window is still becoming visible.
      }
      if (!canFocus()) return
      inputRef.current?.focus({ preventScroll: true })
      requestAnimationFrame(() => {
        if (canFocus()) inputRef.current?.focus({ preventScroll: true })
      })
    }

    delays.forEach(delay => window.setTimeout(() => { void run() }, delay))
  }, [])

  const startLandingJelly = useCallback(() => {
    if (jellyTimerRef.current) clearTimeout(jellyTimerRef.current)
    flushSync(() => setJellyActive(true))
    // `animationend` does not fire when reduced motion disables the CSS
    // animation. Always demote the compositor layer after the motion window.
    jellyTimerRef.current = window.setTimeout(() => {
      jellyTimerRef.current = null
      setJellyActive(false)
    }, JELLY_DURATION_MS + 80)
  }, [])

  const markBarFlight = useCallback((
    duration = TRANSITION_MS,
    onSettled?: () => void,
  ) => {
    if (barFlightTimerRef.current) {
      clearTimeout(barFlightTimerRef.current)
      barFlightTimerRef.current = null
    }
    setBarInFlight(true)
    barFlightTimerRef.current = window.setTimeout(() => {
      barFlightTimerRef.current = null
      setBarInFlight(false)
      onSettled?.()
    }, duration + 20)
  }, [])

  const handleJellyAnimationEnd = useCallback((e: AnimationEvent<HTMLElement>) => {
    if (e.animationName !== 'vision-jelly-pop' && e.animationName !== 'vision-ocr-jelly-pop') return
    if (jellyTimerRef.current) {
      clearTimeout(jellyTimerRef.current)
      jellyTimerRef.current = null
    }
    setJellyActive(false)
  }, [])

  const enterSelect = useCallback(async () => {
    window.dispatchEvent(new Event('screenpilot:vision-session-reset'))
    const previousImageId = imageIdRef.current
    invalidateVisionSurface()
    const surfaceEpoch = visionSurfaceEpochRef.current
    captureSurfaceActiveRef.current = true
    const surfaceIsCurrent = () => (
      surfaceEpoch === visionSurfaceEpochRef.current
      && captureSurfaceActiveRef.current
    )
    invalidateVisionRequest()
    setVisionCursorPassthrough(false)
    void api.visionSetHitRegion(null).catch(err => console.error('[vision-floating] clear hit region failed:', err))
    setHitRegionRect(null)
    stopSpeechPlayback()
    cancelPromptOptimization()
    panelDraggingRef.current = false
    setPanelDragActive(false)
    closingStreamRef.current = false
    if (closeResetTimerRef.current) {
      clearTimeout(closeResetTimerRef.current)
      closeResetTimerRef.current = null
    }
    nativeFlySeqRef.current++
    if (barFlightTimerRef.current) {
      clearTimeout(barFlightTimerRef.current)
      barFlightTimerRef.current = null
    }
    if (jellyTimerRef.current) {
      clearTimeout(jellyTimerRef.current)
      jellyTimerRef.current = null
    }
    if (translateEditDebounceRef.current) {
      clearTimeout(translateEditDebounceRef.current)
      translateEditDebounceRef.current = null
    }
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = null
    }
    if (copyErrorTimeoutRef.current) {
      clearTimeout(copyErrorTimeoutRef.current)
      copyErrorTimeoutRef.current = null
    }
    copySequenceRef.current += 1
    translateEditSeqRef.current++
    translateOriginalEditedRef.current = false
    ignoreTranslateStreamRef.current = false
    fullscreenMetricsRef.current = null
    chatAutoFollowRef.current = true
    resetVisionStreamBuffer()
    justFinishedStreamRef.current = false
    imageIdRef.current = ''
    if (previousImageId) {
      void api.visionDeleteTemporaryImage(previousImageId).catch(err => {
        console.error('[vision-image] temporary cleanup failed:', err)
      })
    }
    textSessionIdRef.current = ''
    // 用 flushSync 同步提交所有 reset 后的状态：webview show 之前 DOM 必须已经反映新位置，
    // 否则 Rust 的 show() 会先把旧 frame 露出来。
    // barNoTransition 同 frame 一起置 true → bar 从老坐标 snap 到 select 坐标，不动画。
    flushSync(() => {
      setBarNoTransition(true)
      setBarFlyOffset({ x: 0, y: 0 })
      setBarRebaseHidden(false)
      setBarInFlight(false)
      setJellyActive(false)
      setStage('select')
      setMode(readModeFromHash())
      setFloatingRebased(false)
      floatingSizeRef.current = null
      setHovered(null)
      setDragStart(null)
      setDragCurrent(null)
      setDragging(false)
      setKeyboardSelectionMode(null)
      setKeyboardRegion(null)
      setA11yAnnouncement('')
      setSelectBarCollapsed(false)
      // 历史下拉是"上一次开窗遗留"的典型：webview 不销毁，state 一直留着。
      // 展开着按 esc 关窗，下次打开还是展开的。两条复位路径都要收掉。
      setHistoryOpen(false)
      setAnimatedHoverRect(null)
      setImagePreview('')
      setAppLabel('')
      setInput('')
      setSelectionText('')
      setMessages([])
      setStreaming(false)
      setCopiedTarget(null)
      setCopyErrorAnnouncement('')
      setCloseFailed(false)
      setTranslateOriginal('')
      setTranslateOriginalError('')
      setTranslateText('')
      setTranslateError('')
      setTranslateDurationMs(null)
      setCaptureWarning('')
      setTranslateRetranslating(false)
      setOcrMethodSwitching(false)
      setTranslationMethodSwitching(false)
      const w = window.innerWidth
      const h = window.innerHeight
      setViewport({ w, h })
      setBarRect(computeSelectBar(w, h, computeMetrics(w, h)))
      setCapturedFrame(null)
      setBarIntro(false)
    })
    try {
      const settings = await api.getSettings()
      if (!surfaceIsCurrent()) return
      const curMode = readModeFromHash()
      const cfg = curMode === 'translate' ? settings.screenshotTranslation : settings.vision
      setLang(settings.settingsLanguage === 'en' ? 'en' : 'zh')
      setActiveVisionModel(resolveVisionModelLabel(settings))
      visionStreamEnabledRef.current = settings.vision?.streamEnabled !== false
      setKeepFullscreen(cfg?.keepFullscreenAfterCapture !== false)
      if (curMode === 'translate') {
        setShowTranslateOriginal(!(settings.screenshotTranslation?.directTranslate ?? false))
        setTranslateOcrMethod(resolveScreenshotOcrMethod(settings))
        setTranslateMethod(resolveScreenshotTranslationMethod(settings))
      }
    } catch (err) {
      if (!surfaceIsCurrent()) return
      console.error('Failed to reload settings', err)
    }
    if (!surfaceIsCurrent()) return
    hoverAnimationRef.current.rect = null
    if (hoverAnimationRef.current.raf !== null) {
      cancelAnimationFrame(hoverAnimationRef.current.raf)
      hoverAnimationRef.current.raf = null
    }
    // 异步 take 走 Rust 端在 vision_request_internal 中暂存的选中文本。
    // token 防御：take 期间用户再开一次 Vision / 关闭，老 promise 落地时 myReq 已过期，丢弃。
    // 仅 chat 模式注入；> 200KB 直接丢弃避免上下文爆炸；trim 后非空才 setSelectionText。
    const myReq = ++selectionReqIdRef.current
    if (readModeFromHash() === 'chat') {
      void (async () => {
        try {
          const text = await api.takeVisionSelection()
          if (!surfaceIsCurrent() || myReq !== selectionReqIdRef.current) return
          if (text.length > 200_000) return
          if (text.trim()) {
            setSelectionText(text)
            focusVisionInput([0, 60, 180])
          }
        } catch (err) {
          console.warn('[vision] take selection failed:', err)
        }
      })()
    }
    requestAnimationFrame(() => {
      if (!surfaceIsCurrent()) return
      // 第二个 raf 同时恢复 transitions 并触发 intro：现在 bar 已经在 select 位置，
      // 只对 transform/opacity 做缩放进入动画，不会回放历史 left/top 过渡。
      requestAnimationFrame(() => {
        if (!surfaceIsCurrent()) return
        setBarIntro(true)
        setBarNoTransition(false)
      })
    })
    let currentOrigin = { x: 0, y: 0 }
    try {
      const win = getCurrentWindow()
      const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()])
      if (!surfaceIsCurrent()) return
      const sf = scale || 1
      currentOrigin = { x: pos.x / sf, y: pos.y / sf }
      setWinOrigin(currentOrigin)
    } catch (err) {
      if (!surfaceIsCurrent()) return
      console.error('Failed to read window origin', err)
    }
    if (!surfaceIsCurrent()) return
    try {
      const [list, cursor] = await Promise.all([
        api.visionListWindows(),
        api.visionCursorPosition().catch((err) => {
          console.warn('[vision] cursor position failed:', err)
          return null
        }),
      ])
      if (!surfaceIsCurrent()) return
      setWindows(list)
      setHovered(cursor ? findWindowAt(list, cursor) : null)
    } catch (err) {
      if (!surfaceIsCurrent()) return
      console.error('Failed to list windows', err)
      setWindows([])
      setHovered(null)
    }
    if (!surfaceIsCurrent()) return
    try {
      await api.showWindow()
    } catch (err) {
      if (surfaceIsCurrent()) console.error('Failed to show Vision window', err)
      return
    }
    if (!surfaceIsCurrent()) {
      // show() may resolve after Rust has already closed this surface. Only
      // compensate when no newer enterSelect session owns the shared window.
      if (!captureSurfaceActiveRef.current) {
        try {
          await api.hideWindow()
        } catch (err) {
          if (!captureSurfaceActiveRef.current) console.error('Failed to re-hide stale Vision window', err)
        }
      }
      return
    }
    focusVisionInput()
  }, [cancelPromptOptimization, focusVisionInput, invalidateVisionRequest, invalidateVisionSurface, resetVisionStreamBuffer, setVisionCursorPassthrough, stopSpeechPlayback])

  useEffect(() => {
    const startSelection = () => {
      void enterSelect().catch(err => {
        console.error('[vision-capture] enter selection failed:', err)
      })
    }
    startSelection()
    const handleReset = () => { startSelection() }
    window.addEventListener('vision:reset', handleReset)
    return () => window.removeEventListener('vision:reset', handleReset)
  }, [enterSelect])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void api.onVisionClosing(() => {
      // UI-initiated close may still fail after Rust emits its best-effort
      // closing notification. Keep the live session valid until visionClose
      // itself confirms success; external/native closes still invalidate it.
      if (closePendingRef.current) return
      invalidateVisionSurface()
    }).then((dispose) => {
      if (cancelled) dispose()
      else unlisten = dispose
    }).catch(error => console.error('[vision-capture] closing listener failed:', error))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [invalidateVisionSurface])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) focusVisionInput([0, 40, 120])
    }).then((dispose) => {
      if (cancelled) dispose()
      else unlisten = dispose
    }).catch(err => console.error('[vision-focus] listen failed:', err))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [focusVisionInput])

  useEffect(() => {
    if (!floatingRebased) return
    let cancelled = false
    let syncTimer: number | null = null
    let unlisten: (() => void) | undefined
    let unlistenScale: (() => void) | undefined
    const win = getCurrentWindow()

    const syncOrigin = async () => {
      syncTimer = null
      try {
        const [position, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()])
        if (cancelled) return
        const factor = scale || 1
        const nextOrigin = { x: position.x / factor, y: position.y / factor }
        setWinOrigin(prev => (
          prev.x === nextOrigin.x && prev.y === nextOrigin.y ? prev : nextOrigin
        ))
        setWindowMoveRevision(prev => prev + 1)
      } catch (error) {
        if (!cancelled) console.error('[vision-floating] window origin sync failed:', error)
      }
    }

    const scheduleSync = () => {
      if (syncTimer !== null) window.clearTimeout(syncTimer)
      syncTimer = window.setTimeout(() => { void syncOrigin() }, 64)
    }

    win.onMoved(scheduleSync).then((dispose) => {
      if (cancelled) dispose()
      else unlisten = dispose
    }).catch(error => console.error('[vision-floating] move listener failed:', error))
    win.onScaleChanged(scheduleSync).then((dispose) => {
      if (cancelled) dispose()
      else unlistenScale = dispose
    }).catch(error => console.error('[vision-floating] scale listener failed:', error))

    return () => {
      cancelled = true
      if (syncTimer !== null) window.clearTimeout(syncTimer)
      unlisten?.()
      unlistenScale?.()
    }
  }, [floatingRebased])

  useEffect(() => {
    const onResize = () => {
      const nextViewport = { w: window.innerWidth, h: window.innerHeight }
      setViewport(nextViewport)

      // Native edge resize changes the WebView client rect without changing
      // the floating bar's remembered local geometry. Keep the bar/card width
      // in the same coordinate space as the current client viewport so the
      // transparent native surface never outruns the rendered panel. The
      // resize effect below will report this measured width back to Rust; the
      // native window remains the source of truth while a user drag is active.
      if (floatingRebased && modeRef.current === 'chat' && stageRef.current !== 'select') {
        setBarRect(prev => {
          const width = Math.max(1, Math.round(nextViewport.w - FLOATING_PADDING * 2))
          if (
            prev.x === FLOATING_PADDING
            && prev.y === FLOATING_PADDING
            && prev.width === width
          ) return prev
          return { ...prev, x: FLOATING_PADDING, y: FLOATING_PADDING, width }
        })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [floatingRebased])

  useEffect(() => {
    if (stageRef.current === 'select') {
      setBarRect(computeSelectBar(viewport.w, viewport.h, metrics))
    }
  }, [viewport, metrics])

  // 流式结束（streaming → false 且有任意 assistant 回答）时把当前会话推入历史。
  // 按 imageId 去重：同一张截图多轮对话作为单条历史持续更新到最前。
  // translate 模式不入对话历史（OCR+翻译是一次性任务，无对话语义）。
  // 缩略图压缩到 96x96 jpeg 再写历史，避免 localStorage 被几 MB 的 base64 撑爆。
  useEffect(() => {
    // 只在真实"流刚结束"路径触发：handleSend / handleStop 的 finally 会先置 ref 再 setStreaming(false)。
    // restoreHistory / enterSelect / resetBeforeHide 调用前会显式清零 ref，避免恢复历史时 effect 误触发。
    if (!justFinishedStreamRef.current) return
    if (mode !== 'chat') return
    if (streaming) return
    if (messages.length === 0) return
    const hasAssistant = messages.some(m => m.role === 'assistant' && m.content)
    if (!hasAssistant) return
    justFinishedStreamRef.current = false

    // 纯文字会话没有 imageId。以前这里用 `!imageIdRef.current` 直接 return，
    // 于是"不截图、只聊天"整段都不会进历史。现在给它一个自造会话 id 照常入库。
    const textOnly = !imageIdRef.current
    if (textOnly && !textSessionIdRef.current) {
      textSessionIdRef.current = makeTextSessionId()
    }
    const id = textOnly ? textSessionIdRef.current : imageIdRef.current
    let cancelled = false
    const persistence = (async () => {
      const thumb = textOnly ? '' : await makeThumbnail(imagePreview, HISTORY_THUMB_SIZE)
      if (cancelled) return
      if (!textOnly) {
        try {
          // 先完成持久化，再写历史元数据，避免关闭窗口时留下无法恢复的记录。
          await api.visionCommitImageToHistory(id)
        } catch (err) {
          console.error('[vision-history] commit failed:', err)
          await api.visionDeleteTemporaryImage(id).catch(cleanupError => {
            console.error('[vision-history] failed image cleanup failed:', cleanupError)
          })
          return
        }
      }
      setHistory(prev => {
        const filtered = prev.filter(h => h.id !== id)
        const next: HistoryItem = {
          id,
          imagePreview: thumb,
          appLabel: textOnly ? '' : appLabel,
          messages,
          capturedFrame: textOnly ? null : capturedFrame,
          timestamp: Date.now(),
          textOnly,
        }
        return [next, ...filtered].slice(0, HISTORY_MAX)
      })
    })()
    historyPersistenceRef.current.add(persistence)
    void persistence.then(
      () => {
        historyPersistenceRef.current.delete(persistence)
      },
      (error: unknown) => {
        historyPersistenceRef.current.delete(persistence)
        console.error('[vision-history] persistence failed:', error)
      },
    )
    return () => { cancelled = true }
  }, [mode, streaming, messages, imagePreview, appLabel, capturedFrame])

  const prevHistoryIdsRef = useRef<Set<string>>(new Set(history.map(h => h.id)))
  useEffect(() => {
    saveVisionHistory(localStorage, history)
    const curIds = new Set(history.map(h => h.id))
    prevHistoryIdsRef.current.forEach(id => {
      if (!curIds.has(id)) {
        api.visionDeleteHistoryImage(id).catch(err => console.error('[vision-history] delete failed:', err))
      }
    })
    prevHistoryIdsRef.current = curIds
  }, [history])

  // 监听 vision-stream 事件：把 reasoning_delta / delta 累积到最后一条 assistant 消息
  // StrictMode 双挂载下 listen 是 async：cleanup 时 unlisten 可能还没赋值，需要 cancelled 旗标
  // 让 promise resolve 时立即 dispose，否则会留下"幽灵 listener"导致每个事件触发 N 次（字符重复）
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let pending: Promise<boolean> | null = null
    const install = async () => {
      if (visionStreamListenerReadyRef.current) return true
      if (pending) return pending
      pending = api.onVisionStream((payload: VisionStreamPayload) => {
      if (!visionRequestLifecycleRef.current.matchesStream(imageIdRef.current, payload)) return
      if (payload.error) {
        const previous = visionTerminalErrorRef.current
        const isNewError = previous?.requestId !== payload.requestId
          || previous.error !== payload.error
          || previous.incompleteReason !== payload.incompleteReason
        if (isNewError) {
          visionTerminalErrorRef.current = {
            requestId: payload.requestId,
            error: payload.error,
            incompleteReason: payload.incompleteReason,
          }
          if (!payload.delta?.includes(payload.error)) {
            const reason = payload.incompleteReason ? ` (${payload.incompleteReason})` : ''
            visionStreamBufferRef.current.content += `\n\n${appendVisionError('', `${payload.error}${reason}`)}`
            scheduleVisionStreamFlush()
          }
        }
      }
      if (payload.reasoningDelta) {
        visionStreamBufferRef.current.reasoning += payload.reasoningDelta
        scheduleVisionStreamFlush()
      }
      if (payload.delta) {
        visionStreamBufferRef.current.content += payload.delta
        scheduleVisionStreamFlush()
      }
      if (payload.done) {
        clearVisionStreamFlushTimer()
        flushVisionStreamBuffer(true)
        if (payload.reason === 'done' || payload.reason === 'error') {
          justFinishedStreamRef.current = true
        }
        setStreaming(false)
        return
      }
      }).then((dispose) => {
        if (cancelled) {
          dispose()
          return false
        }
        unlisten = dispose
        visionStreamListenerReadyRef.current = true
        setStreamListenerError(current => current === 'answer' ? null : current)
        return true
      }).catch(err => {
        if (!cancelled) {
          visionStreamListenerReadyRef.current = false
          setStreamListenerError('answer')
          console.error('[vision-stream] listener registration failed:', err)
        }
        return false
      }).finally(() => {
        pending = null
      })
      return pending
    }
    retryVisionStreamListenerRef.current = install
    void install()
    return () => {
      cancelled = true
      visionStreamListenerReadyRef.current = false
      if (retryVisionStreamListenerRef.current === install) {
        retryVisionStreamListenerRef.current = async () => false
      }
      clearVisionStreamFlushTimer()
      unlisten?.()
    }
  }, [clearVisionStreamFlushTimer, flushVisionStreamBuffer, scheduleVisionStreamFlush])

  const updateChatAutoFollow = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    chatAutoFollowRef.current = isChatAtLiveEdge(el, messageOrder)
  }, [messageOrder])

  // messages 变化时只在用户贴近最新消息时跟随；用户手动滚动离开后不抢滚动位置。
  useLayoutEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    if (chatAutoFollowRef.current) scrollChatToLiveEdge(el, messageOrder)
  }, [messages, messageOrder])

  // Windows WebView2 在 input disabled/read-write 切换后容易丢 caret；回答结束后显式还焦点。
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current
    prevStreamingRef.current = streaming
    if (!wasStreaming || streaming) return
    if (mode !== 'chat') return
    if (historyOpen) return
    if (stageRef.current !== 'answering' && stageRef.current !== 'ready') return

    const id = setTimeout(() => {
      focusVisionInput([0, 60, 160])
    }, 30)
    return () => clearTimeout(id)
  }, [streaming, mode, historyOpen, focusVisionInput])

  // 关闭时重置 state，让隐藏后的 webview surface 回到空 select 态。
  // 否则下次 show 时可能先显示上次的 ready/result 态 surface 一帧，再被 vision:reset 覆盖。
  // barNoTransition：禁用 left/top/width transition，避免 380ms 动画被 hide 暂停后下次 show 续播。
  const resetBeforeHide = useCallback(() => {
    const previousImageId = imageIdRef.current
    invalidateVisionSurface()
    invalidateVisionRequest()
    setVisionCursorPassthrough(false)
    void api.visionSetHitRegion(null).catch(err => console.error('[vision-floating] clear hit region failed:', err))
    setHitRegionRect(null)
    stopSpeechPlayback()
    cancelPromptOptimization()
    panelDraggingRef.current = false
    setPanelDragActive(false)
    if (closeResetTimerRef.current) {
      clearTimeout(closeResetTimerRef.current)
      closeResetTimerRef.current = null
    }
    nativeFlySeqRef.current++
    if (translateEditDebounceRef.current) {
      clearTimeout(translateEditDebounceRef.current)
      translateEditDebounceRef.current = null
    }
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = null
    }
    if (copyErrorTimeoutRef.current) {
      clearTimeout(copyErrorTimeoutRef.current)
      copyErrorTimeoutRef.current = null
    }
    copySequenceRef.current += 1
    translateEditSeqRef.current++
    translateOriginalEditedRef.current = false
    ignoreTranslateStreamRef.current = false
    fullscreenMetricsRef.current = null
    resetVisionStreamBuffer()
    // 防御：和 enterSelect 同理 —— reset 路径不该走持久化
    justFinishedStreamRef.current = false
    imageIdRef.current = ''
    if (previousImageId) {
      void api.visionDeleteTemporaryImage(previousImageId).catch(err => {
        console.error('[vision-image] temporary cleanup failed:', err)
      })
    }
    textSessionIdRef.current = ''
    flushSync(() => {
      setBarNoTransition(true)
      setBarFlyOffset({ x: 0, y: 0 })
      setBarRebaseHidden(false)
      setBarInFlight(false)
      setJellyActive(false)
      setStage('select')
      setFloatingRebased(false)
      setHovered(null)
      setDragStart(null)
      setDragCurrent(null)
      setDragging(false)
      setKeyboardSelectionMode(null)
      setKeyboardRegion(null)
      setA11yAnnouncement('')
      setSelectBarCollapsed(false)
      setHistoryOpen(false)
      setImagePreview('')
      setAppLabel('')
      setInput('')
      setSelectionText('')
      setMessages([])
      setStreaming(false)
      setCopiedTarget(null)
      setCopyErrorAnnouncement('')
      setCloseFailed(false)
      setTranslateOriginal('')
      setTranslateOriginalError('')
      setTranslateText('')
      setTranslateError('')
      setTranslateDurationMs(null)
      setCaptureWarning('')
      setTranslateRetranslating(false)
      setOcrMethodSwitching(false)
      setTranslationMethodSwitching(false)
      setBarRect(computeSelectBar(viewport.w, viewport.h, metrics))
      setCapturedFrame(null)
      setBarIntro(false)
    })
    // 让任何还没落地的 takeVisionSelection 老 promise 作废，避免关闭后 setSelectionText 拖回来
    selectionReqIdRef.current++
    focusReqIdRef.current++
  }, [cancelPromptOptimization, invalidateVisionRequest, invalidateVisionSurface, resetVisionStreamBuffer, viewport, metrics, setVisionCursorPassthrough, stopSpeechPlayback])

  const resetAfterClose = useCallback(() => {
    if (closeResetTimerRef.current) clearTimeout(closeResetTimerRef.current)
    closeResetTimerRef.current = window.setTimeout(() => {
      closeResetTimerRef.current = null
      resetBeforeHide()
    }, 80)
  }, [resetBeforeHide])

  const closeLikeEscape = useCallback(async () => {
    if (closePendingRef.current) return
    closePendingRef.current = true
    setCloseFailed(false)
    setVisionCursorPassthrough(false)
    try {
      if (stageRef.current === 'answering' && streaming) {
        closingStreamRef.current = true
        try { await api.visionCancelStream() } catch (err) { console.error(err) }
        clearVisionStreamFlushTimer()
        flushVisionStreamBuffer(true)
        setStreaming(false)
      }
      if (historyPersistenceRef.current.size > 0) {
        await Promise.allSettled([...historyPersistenceRef.current])
      }
      await api.visionClose()
      invalidateVisionSurface()
      invalidateVisionRequest()
      setVisionCursorPassthrough(false)
      resetAfterClose()
    } catch (err) {
      closingStreamRef.current = false
      setCloseFailed(true)
      console.error('[vision-close] failed:', err)
    } finally {
      closePendingRef.current = false
    }
  }, [clearVisionStreamFlushTimer, flushVisionStreamBuffer, invalidateVisionRequest, invalidateVisionSurface, resetAfterClose, setVisionCursorPassthrough, streaming])

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stageRef.current === 'select' && keyboardSelectionMode !== null) {
        e.preventDefault()
        e.stopPropagation()
        setKeyboardSelectionMode(null)
        setKeyboardRegion(null)
        setHovered(null)
        setA11yAnnouncement(lang === 'zh' ? '已退出键盘截图选择。' : 'Keyboard screenshot selection cancelled.')
        return
      }
      await closeLikeEscape()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeLikeEscape, keyboardSelectionMode, lang])

  useEffect(() => {
    if (!drawMode) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setDrawMode(false)
        setDraftArrow(null)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !isInput) {
        e.preventDefault()
        e.stopPropagation()
        setArrows(prev => {
          if (prev.length > 0) {
            setA11yAnnouncement(lang === 'zh' ? '已撤销上一支箭头。' : 'Previous arrow removed.')
          }
          return prev.slice(0, -1)
        })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drawMode, lang])

  useEffect(() => {
    if (!drawMode) return
    setA11yAnnouncement(lang === 'zh'
      ? '箭头标注已开启。按 Enter 创建箭头，方向键调整终点，Shift+方向键平移，再按 Enter 提交。'
      : 'Arrow annotation enabled. Press Enter to create an arrow, use Arrow keys to adjust its endpoint, Shift+Arrow keys to move it, then press Enter to commit.')
    const frame = window.requestAnimationFrame(() => drawSurfaceRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [drawMode, lang])

  // select 态切到其他应用 → 自动收起灰幕。
  // 注意：截图过程中 screencapture 可能让 vision 短暂失焦，capturingRef 防止误关。
  useEffect(() => {
    const handleBlur = () => {
      if (!captureSurfaceActiveRef.current) return
      if (capturingRef.current) return
      if (stageRef.current === 'select') {
        void closeLikeEscape()
      }
    }
    window.addEventListener('blur', handleBlur)
    return () => window.removeEventListener('blur', handleBlur)
  }, [closeLikeEscape])

  const clientToGlobal = (p: Point): Point => ({
    x: winOrigin.x + p.x,
    y: winOrigin.y + p.y,
  })

  const hitTest = (gp: Point): VisionWindowInfo | null => {
    return findWindowAt(windows, gp)
  }

  const dragRect = useMemo(() => {
    if (!dragStart || !dragCurrent) return null
    const x = Math.min(dragStart.x, dragCurrent.x)
    const y = Math.min(dragStart.y, dragCurrent.y)
    const w = Math.abs(dragCurrent.x - dragStart.x)
    const h = Math.abs(dragCurrent.y - dragStart.y)
    return { x, y, width: w, height: h }
  }, [dragStart, dragCurrent])

  const hoverRect = useMemo(() => {
    if (!hovered || dragging) return null
    return {
      x: hovered.x - winOrigin.x,
      y: hovered.y - winOrigin.y,
      width: hovered.width,
      height: hovered.height,
    }
  }, [hovered, dragging, winOrigin])

  useEffect(() => {
    const hoverAnimation = hoverAnimationRef.current
    if (hoverAnimation.raf !== null) {
      cancelAnimationFrame(hoverAnimation.raf)
      hoverAnimation.raf = null
    }

    if (dragging || !hoverRect) {
      hoverAnimation.rect = hoverRect
      setAnimatedHoverRect(hoverRect)
      return
    }

    const from = hoverAnimation.rect ?? hoverRect
    const to = hoverRect
    if (rectEquals(from, to)) {
      hoverAnimation.rect = to
      setAnimatedHoverRect(to)
      return
    }

    const startedAt = performance.now()
    const step = (now: number) => {
      const tLinear = Math.min((now - startedAt) / SHAREX_REGION_ANIMATION_MS, 1)
      const next = lerpRect(from, to, tLinear)
      hoverAnimation.rect = next
      setAnimatedHoverRect(next)
      if (tLinear < 1) {
        hoverAnimation.raf = requestAnimationFrame(step)
      } else {
        hoverAnimation.raf = null
      }
    }

    hoverAnimation.raf = requestAnimationFrame(step)
    return () => {
      if (hoverAnimation.raf !== null) {
        cancelAnimationFrame(hoverAnimation.raf)
        hoverAnimation.raf = null
      }
    }
  }, [hoverRect, dragging])

  const selectFocusRect = useMemo(() => {
    const keyboardRect = keyboardSelectionMode === 'region'
      ? keyboardRegion
      : keyboardSelectionMode === 'window'
        ? animatedHoverRect
        : null
    return clampRect(dragging && dragRect ? dragRect : keyboardRect, viewport)
  }, [animatedHoverRect, dragging, dragRect, keyboardRegion, keyboardSelectionMode, viewport])

  const selectFrameRect = useMemo(() => {
    const keyboardRect = keyboardSelectionMode === 'region' ? keyboardRegion : animatedHoverRect
    return clampRect(dragging && dragRect ? dragRect : keyboardRect, viewport)
  }, [dragging, dragRect, animatedHoverRect, keyboardRegion, keyboardSelectionMode, viewport])

  const selectFrameText = useMemo(() => {
    if (!selectFrameRect) return ''
    const x = winOrigin.x + selectFrameRect.x
    const y = winOrigin.y + selectFrameRect.y
    return `X: ${Math.round(x)}, Y: ${Math.round(y)}, ${Math.round(selectFrameRect.width)} x ${Math.round(selectFrameRect.height)}`
  }, [selectFrameRect, winOrigin])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (stage !== 'select') return
    setKeyboardSelectionMode(null)
    setKeyboardRegion(null)
    const p: Point = { x: e.clientX, y: e.clientY }
    setDragStart(p)
    setDragCurrent(p)
    setDragging(false)
    setSelectBarCollapsed(false)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (stage !== 'select') return
    const p: Point = { x: e.clientX, y: e.clientY }
    if (dragStart) {
      setDragCurrent(p)
      const dx = Math.abs(p.x - dragStart.x)
      const dy = Math.abs(p.y - dragStart.y)
      if (!dragging && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
        setDragging(true)
        setSelectBarCollapsed(true)
        setHistoryOpen(false)
        inputRef.current?.blur()
        setHovered(null)
      }
      return
    }
    const gp = clientToGlobal(p)
    setHovered(hitTest(gp))
  }

  const resolveFloatingAnchor = (
    anchorAbsX: number,
    anchorAbsY: number,
    anchorW: number,
    anchorH: number,
    activeMode: Mode = modeRef.current,
  ) => {
    const ax = anchorAbsX - winOrigin.x
    const ay = anchorAbsY - winOrigin.y
    const vw = window.innerWidth
    const vh = window.innerHeight
    const READY_W = metrics.READY_W
    const ANSWER_H = metrics.ANSWER_H

    const rightStart = ax + anchorW + ANCHOR_GAP
    const spaceRight = vw - rightStart - 16
    const spaceLeft = ax - ANCHOR_GAP - 16

    let targetX: number
    if (spaceRight >= READY_W) {
      targetX = rightStart
    } else if (spaceLeft >= READY_W) {
      targetX = ax - READY_W - ANCHOR_GAP
    } else {
      targetX = spaceRight >= spaceLeft ? vw - READY_W - 16 : 16
    }

    const totalH = READY_BAR_H + 8 + ANSWER_H
    let targetY = ay + anchorH / 2 - READY_BAR_H / 2
    if (targetY + totalH > vh - 16) targetY = vh - totalH - 16
    if (targetY < 16) targetY = 16

    if (targetX < 16) targetX = 16
    if (targetX + READY_W > vw - 16) targetX = vw - READY_W - 16

    const targetStage: Stage = activeMode === 'translate' ? 'translating' : 'ready'
    const targetHeight = targetStage === 'translating'
      ? READY_BAR_H + FLOATING_GAP + ANSWER_H
      : READY_BAR_H

    return {
      localX: Math.round(targetX),
      localY: Math.round(targetY),
      windowX: Math.round(winOrigin.x + targetX),
      windowY: Math.round(winOrigin.y + targetY),
      width: READY_W,
      height: targetHeight,
      stage: targetStage,
    }
  }

  const flyBarToAnchor = async (
    anchorAbsX: number,
    anchorAbsY: number,
    anchorW: number,
    anchorH: number,
    label: string,
  ) => {
    const target = resolveFloatingAnchor(anchorAbsX, anchorAbsY, anchorW, anchorH)
    const targetX = target.localX
    const targetY = target.localY
    const READY_W = target.width
    const targetStage = target.stage

    const flySeq = ++nativeFlySeqRef.current

    if (!keepFullscreen) {
      fullscreenMetricsRef.current = metrics
      const contentWidth = Math.round(READY_W)
      const contentHeight = Math.round(target.height)
      const width = contentWidth + FLOATING_PADDING * 2
      const height = contentHeight + FLOATING_PADDING * 2
      const fromOrigin = {
        x: Math.round(winOrigin.x + barRect.x - FLOATING_PADDING),
        y: Math.round(winOrigin.y + barRect.y - FLOATING_PADDING),
      }
      const targetOrigin = {
        x: Math.round(target.windowX - FLOATING_PADDING),
        y: Math.round(target.windowY - FLOATING_PADDING),
      }

      flushSync(() => {
        setAppLabel(label)
        setFloatingRebased(false)
        setNativeHitRegionActive(false)
        setHitRegionRect(null)
        floatingSizeRef.current = null
        setBarNoTransition(true)
        setBarRebaseHidden(true)
        setBarInFlight(false)
        setJellyActive(false)
        setSelectBarCollapsed(false)
        setBarFlyOffset({ x: 0, y: 0 })
        setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
        setStage(targetStage)
      })

      try {
        // The fullscreen selection path may have installed a native hit
        // region while the bar was still rebasing. Clear it before shrinking
        // the HWND so a late region update cannot leave transparent pixels
        // intercepting desktop clicks in the new floating client rect.
        await api.visionSetHitRegion(null)
        if (flySeq !== nativeFlySeqRef.current) return
        const applied = await setVisionFloatingWithRetry({
          x: fromOrigin.x,
          y: fromOrigin.y,
          width,
          height,
          hasScreenshot: true,
        }, () => flySeq === nativeFlySeqRef.current)
        if (!applied || flySeq !== nativeFlySeqRef.current) return
        flushSync(() => {
          setFloatingRebased(true)
          setWinOrigin(fromOrigin)
          setViewport({ w: width, h: height })
          setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
          setBarRebaseHidden(false)
          floatingSizeRef.current = { width, height, hasScreenshot: true }
        })

        await api.visionFlyFloating({
          from: fromOrigin,
          to: targetOrigin,
          width,
          height,
          hasScreenshot: true,
          durationMs: NATIVE_FLOATING_FLY_MS,
        })
        if (flySeq !== nativeFlySeqRef.current) return

        flushSync(() => {
          setWinOrigin(targetOrigin)
          setViewport({ w: width, h: height })
          setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
          setBarRebaseHidden(false)
          setBarNoTransition(false)
          setJellyActive(false)
          floatingSizeRef.current = { width, height, hasScreenshot: true }
        })
        if (
          flySeq === nativeFlySeqRef.current
          && shouldRunVisionLandingJelly()
        ) {
          startLandingJelly()
        }
      } catch (err) {
        if (flySeq !== nativeFlySeqRef.current) return
        console.error('[vision-floating] native floating failed:', err)
        flushSync(() => {
          setFloatingRebased(false)
          setBarRebaseHidden(false)
          setBarNoTransition(false)
          setJellyActive(false)
          setBarRect({
            x: Math.round(targetX),
            y: Math.round(targetY),
            width: contentWidth,
          })
        })
      }

      if (mode === 'chat' && flySeq === nativeFlySeqRef.current) {
        focusVisionInput([30, 120, 260])
      }
      return
    } else {
      const nextBarRect = { x: Math.round(targetX), y: Math.round(targetY), width: READY_W }
      const fromBarRect = barRect
      flushSync(() => {
        setAppLabel(label)
        setBarNoTransition(true)
        setBarInFlight(true)
        setJellyActive(false)
        setSelectBarCollapsed(false)
        setBarFlyOffset({
          x: Math.round(fromBarRect.x - nextBarRect.x),
          y: Math.round(fromBarRect.y - nextBarRect.y),
        })
        setBarRect(nextBarRect)
        setStage(targetStage)
      })
      requestAnimationFrame(() => {
        if (flySeq !== nativeFlySeqRef.current) return
        requestAnimationFrame(() => {
          if (flySeq !== nativeFlySeqRef.current) return
          setBarNoTransition(false)
          setBarFlyOffset({ x: 0, y: 0 })
          markBarFlight(TRANSITION_MS, () => {
            if (
              flySeq === nativeFlySeqRef.current
              && shouldRunVisionLandingJelly()
            ) {
              startLandingJelly()
            }
          })
        })
      })
    }
    if (mode === 'chat' && flySeq === nativeFlySeqRef.current) {
      focusVisionInput([TRANSITION_MS + 20, TRANSITION_MS + 120, TRANSITION_MS + 260])
    }
  }

  const runTranslate = useCallback(async (id: string) => {
    if (!await ensureTranslateStreamListener()) {
      translateStartRef.current = null
      setTranslateRetranslating(false)
      setTranslateError(i18n[lang].visionStreamListenerFailed)
      setStage('translated')
      return
    }
    if (translateEditDebounceRef.current) {
      clearTimeout(translateEditDebounceRef.current)
      translateEditDebounceRef.current = null
    }
    translateEditSeqRef.current++
    translateOriginalEditedRef.current = false
    ignoreTranslateStreamRef.current = false
    setTranslateOriginal('')
    setTranslateOriginalError('')
    setTranslateText('')
    setTranslateError('')
    setTranslateDurationMs(null)
    setTranslateRetranslating(false)
    translateStartRef.current = Date.now()
    setTranslateNow(Date.now())
    setStage('translating')
    try {
      const r = await api.visionTranslate(id)
      if (!r.success) {
        const message = r.error || 'Failed'
        if (!showTranslateOriginalRef.current || translateOriginalRef.current.trim() || translateTextRef.current.trim()) {
          setTranslateError(message)
        } else {
          setTranslateOriginalError(message)
        }
        if (translateStartRef.current !== null) {
          setTranslateDurationMs(Date.now() - translateStartRef.current)
          translateStartRef.current = null
        }
        setStage('translated')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!showTranslateOriginalRef.current || translateOriginalRef.current.trim() || translateTextRef.current.trim()) {
        setTranslateError(message)
      } else {
        setTranslateOriginalError(message)
      }
      if (translateStartRef.current !== null) {
        setTranslateDurationMs(Date.now() - translateStartRef.current)
        translateStartRef.current = null
      }
      setStage('translated')
    }
  }, [ensureTranslateStreamListener, lang])

  const handleTranslateOriginalChange = useCallback((value: string) => {
    const normalizedValue = normalizeEnglishPunctuationSpacing(value)
    if (normalizedValue === translateOriginal) return
    if (!ignoreTranslateStreamRef.current) {
      void api.visionCancelStream().catch(err => console.error('[vision-translate] cancel stream failed:', err))
    }
    ignoreTranslateStreamRef.current = true
    translateOriginalEditedRef.current = true
    translateEditSeqRef.current++
    if (translateEditDebounceRef.current) {
      clearTimeout(translateEditDebounceRef.current)
      translateEditDebounceRef.current = null
    }
    setTranslateOriginal(normalizedValue)
    setTranslateOriginalError('')
    setTranslateText('')
    setTranslateError('')
    setTranslateDurationMs(null)
    setTranslateRetranslating(!!normalizedValue.trim())
    translateStartRef.current = normalizedValue.trim() ? Date.now() : null
    setTranslateNow(Date.now())
    setStage(normalizedValue.trim() ? 'translating' : 'translated')
  }, [translateOriginal])

  useEffect(() => {
    if (!translateOriginalEditedRef.current) return
    if (!showTranslateOriginal) return
    if (modeRef.current !== 'translate') return
    if (stageRef.current !== 'translating' && stageRef.current !== 'translated') return

    if (translateEditDebounceRef.current) {
      clearTimeout(translateEditDebounceRef.current)
      translateEditDebounceRef.current = null
    }

    const source = translateOriginal.trim()
    if (!source) {
      translateEditSeqRef.current++
      setTranslateText('')
      setTranslateError('')
      setTranslateDurationMs(null)
      setTranslateRetranslating(false)
      translateStartRef.current = null
      setStage('translated')
      return
    }

    const seq = ++translateEditSeqRef.current
    const timer = window.setTimeout(() => {
      translateEditDebounceRef.current = null
      if (seq !== translateEditSeqRef.current) return
      if (translateStartRef.current === null) {
        translateStartRef.current = Date.now()
      }
      setTranslateNow(Date.now())
      void (async () => {
        try {
          const result = await api.visionTranslateText(source)
          if (seq === translateEditSeqRef.current) {
            if (result.success) {
              setTranslateError('')
              setTranslateText(normalizeEnglishPunctuationSpacing(result.translated || ''))
            } else {
              setTranslateError(result.error || 'Failed')
              setTranslateText('')
            }
          }
        } catch (err) {
          if (seq === translateEditSeqRef.current) {
            setTranslateError(err instanceof Error ? err.message : String(err))
            setTranslateText('')
          }
        } finally {
          if (seq === translateEditSeqRef.current) {
            if (translateStartRef.current !== null) {
              setTranslateDurationMs(Date.now() - translateStartRef.current)
              translateStartRef.current = null
            }
            setTranslateRetranslating(false)
            setStage('translated')
          }
        }
      })()
    }, 1000)
    translateEditDebounceRef.current = timer

    return () => {
      if (translateEditDebounceRef.current === timer) {
        translateEditDebounceRef.current = null
      }
      clearTimeout(timer)
    }
  }, [showTranslateOriginal, translateOriginal])

  const saveScreenshotTranslationSettings = useCallback(async (
    updates: Partial<Settings['screenshotTranslation']>,
  ): Promise<Settings> => {
    return api.updateScreenshotTranslationSettings(updates)
  }, [])

  const runTranslateTextNow = useCallback(async (sourceText = translateOriginal) => {
    const source = normalizeEnglishPunctuationSpacing(sourceText).trim()
    if (translateEditDebounceRef.current) {
      clearTimeout(translateEditDebounceRef.current)
      translateEditDebounceRef.current = null
    }
    const seq = ++translateEditSeqRef.current
    translateOriginalEditedRef.current = true
    ignoreTranslateStreamRef.current = true
    void api.visionCancelStream().catch(err => console.error('[vision-translate] cancel stream failed:', err))

    if (!source) {
      setTranslateText('')
      setTranslateError('')
      setTranslateDurationMs(null)
      setTranslateRetranslating(false)
      translateStartRef.current = null
      setStage('translated')
      return
    }

    setTranslateText('')
    setTranslateError('')
    setTranslateDurationMs(null)
    setTranslateRetranslating(true)
    translateStartRef.current = Date.now()
    setTranslateNow(Date.now())
    setStage('translating')

    try {
      const result = await api.visionTranslateText(source)
      if (seq === translateEditSeqRef.current) {
        if (result.success) {
          setTranslateError('')
          setTranslateText(normalizeEnglishPunctuationSpacing(result.translated || ''))
        } else {
          setTranslateError(result.error || 'Failed')
          setTranslateText('')
        }
      }
    } catch (err) {
      if (seq === translateEditSeqRef.current) {
        setTranslateError(err instanceof Error ? err.message : String(err))
        setTranslateText('')
      }
    } finally {
      if (seq === translateEditSeqRef.current) {
        if (translateStartRef.current !== null) {
          setTranslateDurationMs(Date.now() - translateStartRef.current)
          translateStartRef.current = null
        }
        setTranslateRetranslating(false)
        setStage('translated')
      }
    }
  }, [translateOriginal])

  const handleOcrMethodSelect = useCallback(async (value: string) => {
    const method = value as ScreenshotOcrMethod
    if (method === translateOcrMethod) return
    if (ocrMethodSwitching || translationMethodSwitching) return
    stopSpeechPlayback()
    setOcrMethodSwitching(true)
    try {
      await api.visionCancelStream().catch(err => console.error('[vision-translate] cancel stream failed:', err))
      ignoreTranslateStreamRef.current = true
      const settings = await saveScreenshotTranslationSettings({
        ocrMethod: method,
        useSystemOcr: method === 'system',
      })
      setTranslateOcrMethod(method)

      if (translateEditDebounceRef.current) {
        clearTimeout(translateEditDebounceRef.current)
        translateEditDebounceRef.current = null
      }
      translateEditSeqRef.current++
      translateOriginalEditedRef.current = false
      ignoreTranslateStreamRef.current = false
      translateStartRef.current = null
      setTranslateOriginal('')
      setTranslateText('')
      setTranslateError('')
      setTranslateDurationMs(null)
      setTranslateRetranslating(false)

      const configError = ocrConfigError(settings, method, lang)
      setTranslateOriginalError(showTranslateOriginalRef.current ? configError : '')
      if (!showTranslateOriginalRef.current) setTranslateError(configError)
      if (configError) {
        setStage('translated')
        return
      }

      const imageId = imageIdRef.current
      if (!imageId) {
        const message = lang === 'zh' ? '请先截图后再切换 OCR 接口。' : 'Capture a screenshot before switching OCR providers.'
        if (showTranslateOriginalRef.current) setTranslateOriginalError(message)
        else setTranslateError(message)
        setStage('translated')
        return
      }
      await runTranslate(imageId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (showTranslateOriginalRef.current) {
        setTranslateOriginalError(message)
        setTranslateError('')
      } else {
        setTranslateError(message)
      }
      setTranslateText('')
      setTranslateRetranslating(false)
      translateStartRef.current = null
      setStage('translated')
    } finally {
      setOcrMethodSwitching(false)
    }
  }, [
    lang,
    ocrMethodSwitching,
    runTranslate,
    saveScreenshotTranslationSettings,
    stopSpeechPlayback,
    translateOcrMethod,
    translationMethodSwitching,
  ])

  const handleTranslationMethodSelect = useCallback(async (value: string) => {
    const method = value as ScreenshotTranslationMethod
    if (method === translateMethod) return
    if (ocrMethodSwitching || translationMethodSwitching) return
    stopSpeechPlayback()
    setTranslationMethodSwitching(true)
    try {
      await api.visionCancelStream().catch(err => console.error('[vision-translate] cancel stream failed:', err))
      ignoreTranslateStreamRef.current = true
      const settings = await saveScreenshotTranslationSettings({ translationMethod: method })
      setTranslateMethod(method)

      if (translateEditDebounceRef.current) {
        clearTimeout(translateEditDebounceRef.current)
        translateEditDebounceRef.current = null
      }
      translateEditSeqRef.current++
      translateStartRef.current = null
      setTranslateText('')
      setTranslateError('')
      setTranslateDurationMs(null)
      setTranslateRetranslating(false)

      const configError = translationConfigError(settings, method, lang)
      if (configError) {
        setTranslateError(configError)
        setStage('translated')
        return
      }

      const source = translateOriginalRef.current
      if (source.trim()) {
        await runTranslateTextNow(source)
      } else if (imageIdRef.current && !translateOriginalError) {
        await runTranslate(imageIdRef.current)
      } else {
        setStage('translated')
      }
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : String(err))
      setTranslateText('')
      setTranslateRetranslating(false)
      translateStartRef.current = null
      setStage('translated')
    } finally {
      setTranslationMethodSwitching(false)
    }
  }, [
    lang,
    runTranslate,
    runTranslateTextNow,
    saveScreenshotTranslationSettings,
    stopSpeechPlayback,
    ocrMethodSwitching,
    translateMethod,
    translateOriginalError,
    translationMethodSwitching,
  ])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let pending: Promise<boolean> | null = null
    const install = async () => {
      if (translateStreamListenerReadyRef.current) return true
      if (pending) return pending
      pending = api.onVisionTranslateStream((payload: VisionTranslateStreamPayload) => {
      if (payload.imageId !== imageIdRef.current) return
      if (ignoreTranslateStreamRef.current) return
      if (payload.done) {
        if (payload.error) {
          if (!showTranslateOriginalRef.current || translateOriginalRef.current.trim() || translateTextRef.current.trim()) {
            setTranslateError(payload.error)
          } else {
            setTranslateOriginalError(payload.error)
          }
        }
        if (translateStartRef.current !== null) {
          setTranslateDurationMs(Date.now() - translateStartRef.current)
          translateStartRef.current = null
        }
        setStage('translated')
        return
      }
      if (!payload.delta) return
      if (payload.kind === 'original') {
        setTranslateOriginalError('')
        setTranslateOriginal(prev => normalizeEnglishPunctuationSpacing(prev + payload.delta))
      } else if (payload.kind === 'translated') {
        setTranslateText(prev => normalizeEnglishPunctuationSpacing(prev + payload.delta))
      }
      }).then((dispose) => {
        if (cancelled) {
          dispose()
          return false
        }
        unlisten = dispose
        translateStreamListenerReadyRef.current = true
        setStreamListenerError(current => current === 'translate' ? null : current)
        return true
      }).catch(err => {
        if (!cancelled) {
          translateStreamListenerReadyRef.current = false
          setStreamListenerError('translate')
          console.error('[vision-translate] listener registration failed:', err)
        }
        return false
      }).finally(() => {
        pending = null
      })
      return pending
    }
    retryTranslateStreamListenerRef.current = install
    void install()
    return () => {
      cancelled = true
      translateStreamListenerReadyRef.current = false
      if (retryTranslateStreamListenerRef.current === install) {
        retryTranslateStreamListenerRef.current = async () => false
      }
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (stage !== 'translating') return
    const id = setInterval(() => setTranslateNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [stage])

  const handleCaptureWindow = async (info: VisionWindowInfo) => {
    // capturingRef 全程 true，避免 macOS screencapture 短暂让 vision webview 失焦时触发 blur handler 误关
    const captureSequence = ++captureSequenceRef.current
    capturingRef.current = true
    try {
      const result = await api.visionCaptureWindow(info.id)
      if (!await captureResultIsCurrent(captureSequence)) {
        await deleteStaleCaptureImage(result.success ? result.imageId : undefined)
        return
      }
      showArchiveWarning(result.archiveWarning)
      if (!result.success || !result.imageId) {
        console.error('visionCaptureWindow failed:', result.error)
        const fallbackRect = {
          x: info.x - winOrigin.x,
          y: info.y - winOrigin.y,
          width: info.width,
          height: info.height,
        }
        if (fallbackRect.width >= 10 && fallbackRect.height >= 10) {
          await handleCaptureRegion(fallbackRect, info.owner, captureSequence)
        } else {
          await enterSelect()
        }
        return
      }
      const newId = result.imageId
      const frame = {
        x: info.x - winOrigin.x,
        y: info.y - winOrigin.y,
        width: info.width,
        height: info.height,
        label: info.owner,
      }

      imageIdRef.current = newId

      setCapturedFrame(frame)
      void (async () => {
        try {
          const img = await api.explainReadImage(newId)
          if (img.success && await captureResultIsCurrent(captureSequence)) {
            setImagePreview(img.data ?? '')
          }
        } catch (err) { console.error(err) }
      })()
      await flyBarToAnchor(
        Math.round(info.x), Math.round(info.y), Math.round(info.width), Math.round(info.height),
        info.owner,
      )
      if (!await captureResultIsCurrent(captureSequence)) {
        await deleteStaleCaptureImage(newId)
        return
      }
      if (mode === 'translate') void runTranslate(newId)
    } catch (err) {
      if (captureSequence === captureSequenceRef.current) {
        console.error('[vision-capture] window capture failed:', err)
      }
    } finally {
      if (captureSequence === captureSequenceRef.current) capturingRef.current = false
    }
  }

  const startCaptureWindow = useCallback((info: VisionWindowInfo) => {
    void handleCaptureWindow(info).catch(err => {
      console.error('[vision-capture] window capture handler failed:', err)
    })
  }, [handleCaptureWindow])

  const handleCaptureRegion = async (
    rect: Rect,
    label = '',
    existingCaptureSequence?: number,
  ) => {
    const gp = clientToGlobal({ x: rect.x, y: rect.y })
    const params = {
      absoluteX: Math.round(gp.x),
      absoluteY: Math.round(gp.y),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      scaleFactor: window.devicePixelRatio || 1,
    }
    // capturingRef 全程 true 直到 flyBarToAnchor 完成（同 handleCaptureWindow 注释）
    const captureSequence = existingCaptureSequence ?? ++captureSequenceRef.current
    capturingRef.current = true
    try {
      const result = await api.visionCaptureRegion(params)
      if (!await captureResultIsCurrent(captureSequence)) {
        await deleteStaleCaptureImage(result.success ? result.imageId : undefined)
        return
      }
      showArchiveWarning(result.archiveWarning)
      if (!result.success || !result.imageId) {
        console.error('visionCaptureRegion failed:', result.error)
        await enterSelect()
        return
      }
      const newId = result.imageId
      const frame = {
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        label,
      }

      imageIdRef.current = newId

      setCapturedFrame(frame)
      void (async () => {
        try {
          const img = await api.explainReadImage(newId)
          if (img.success && await captureResultIsCurrent(captureSequence)) {
            setImagePreview(img.data ?? '')
          }
        } catch (err) { console.error(err) }
      })()
      await flyBarToAnchor(params.absoluteX, params.absoluteY, params.width, params.height, label)
      if (!await captureResultIsCurrent(captureSequence)) {
        await deleteStaleCaptureImage(newId)
        return
      }
      if (mode === 'translate') void runTranslate(newId)
    } catch (err) {
      if (captureSequence === captureSequenceRef.current) {
        console.error('[vision-capture] region capture failed:', err)
      }
    } finally {
      if (captureSequence === captureSequenceRef.current) capturingRef.current = false
    }
  }

  const startCaptureRegion = useCallback((rect: Rect) => {
    void handleCaptureRegion(rect).catch(err => {
      console.error('[vision-capture] region capture handler failed:', err)
    })
  }, [handleCaptureRegion])

  const handleMouseUp = async (e: React.MouseEvent) => {
    if (stage !== 'select') return
    const releasedAt: Point = { x: e.clientX, y: e.clientY }

    if (dragging && dragStart) {
      const x = Math.min(dragStart.x, releasedAt.x)
      const y = Math.min(dragStart.y, releasedAt.y)
      const w = Math.abs(releasedAt.x - dragStart.x)
      const h = Math.abs(releasedAt.y - dragStart.y)
      setDragStart(null)
      setDragCurrent(null)
      setDragging(false)
      if (w < 10 || h < 10) {
        setSelectBarCollapsed(false)
        return
      }
      await handleCaptureRegion({ x, y, width: w, height: h })
      return
    }

    setDragStart(null)
    setDragCurrent(null)
    setDragging(false)
    setSelectBarCollapsed(false)
    if (hovered) {
      await handleCaptureWindow(hovered)
    }
  }

  useEffect(() => {
    if (stage !== 'select') return

    const describeWindow = (info: VisionWindowInfo) => {
      const label = info.owner || (lang === 'zh' ? '未命名窗口' : 'Unnamed window')
      return lang === 'zh'
        ? `已选择窗口：${label}，${Math.round(info.width)} × ${Math.round(info.height)}。按 Alt+Enter 截图。`
        : `Window selected: ${label}, ${Math.round(info.width)} by ${Math.round(info.height)}. Press Alt+Enter to capture.`
    }
    const describeRegion = (rect: Rect) => lang === 'zh'
      ? `已选择区域：X ${Math.round(winOrigin.x + rect.x)}，Y ${Math.round(winOrigin.y + rect.y)}，${Math.round(rect.width)} × ${Math.round(rect.height)}。`
      : `Region selected: X ${Math.round(winOrigin.x + rect.x)}, Y ${Math.round(winOrigin.y + rect.y)}, ${Math.round(rect.width)} by ${Math.round(rect.height)}.`

    const selectWindow = (direction: -1 | 1) => {
      const currentIndex = hovered === null ? -1 : windows.findIndex(candidate => candidate.id === hovered.id)
      const index = nextWindowIndex(windows.length, currentIndex, direction)
      if (index < 0) {
        setKeyboardSelectionMode('window')
        setKeyboardRegion(null)
        setA11yAnnouncement(lang === 'zh' ? '没有可选择的窗口。' : 'No selectable windows are available.')
        return
      }
      const next = windows[index]
      setKeyboardSelectionMode('window')
      setKeyboardRegion(null)
      setHovered(next)
      setA11yAnnouncement(describeWindow(next))
    }

    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      const isArrow = event.key === 'ArrowLeft'
        || event.key === 'ArrowRight'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown'

      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        selectWindow(1)
        return
      }

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault()
        event.stopPropagation()
        const region = defaultKeyboardRegion(viewport)
        setKeyboardSelectionMode('region')
        setKeyboardRegion(region)
        setHovered(null)
        setA11yAnnouncement(`${describeRegion(region)} ${lang === 'zh' ? '使用 Alt+方向键移动，Alt+Shift+方向键调整大小，Alt+Enter 截图。' : 'Use Alt+Arrow keys to move, Alt+Shift+Arrow keys to resize, and Alt+Enter to capture.'}`)
        return
      }

      if (event.key === 'Enter') {
        if (keyboardSelectionMode === 'window' && hovered !== null) {
          event.preventDefault()
          event.stopPropagation()
          startCaptureWindow(hovered)
        } else if (keyboardSelectionMode === 'region' && keyboardRegion !== null) {
          event.preventDefault()
          event.stopPropagation()
          startCaptureRegion(keyboardRegion)
        }
        return
      }

      if (!isArrow) return
      event.preventDefault()
      event.stopPropagation()

      if (keyboardSelectionMode === 'region' && keyboardRegion !== null) {
        const next = adjustKeyboardRegion(
          keyboardRegion,
          viewport,
          event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
          event.shiftKey,
        )
        setKeyboardRegion(next)
        setA11yAnnouncement(describeRegion(next))
        return
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        selectWindow(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    hovered,
    keyboardRegion,
    keyboardSelectionMode,
    lang,
    startCaptureRegion,
    startCaptureWindow,
    stage,
    viewport,
    winOrigin,
    windows,
  ])


  /**
   * 纯文字场景：把输入条从当前位置（select 态时在屏幕底部）Q 弹飞到上半部的固定落点，
   * 宽度保持不变，飞完再由调用方展开回答面板 / 优化卡。
   *
   * 三步和截图后的 flyBarToAnchor 完全一致：
   *   1. 原位把窗口收成「只有输入条」的小窗
   *   2. visionFlyFloating 让原生窗口带动画移动到落点
   *   3. 下一帧打开 jellyActive，CSS 的 vision-jelly-pop 补上落地的回弹
   * 顺带：vision_set_floating 在 Windows 上会关掉冻结桌面那层遮罩。
   *
   * beforeFlush 让调用方把自己的状态塞进同一次 flushSync，避免多一帧闪烁。
   */
  const flyBarToTopSlot = useCallback(async (
    requestId?: string,
    beforeFlush?: () => void,
    hasScreenshot = false,
  ) => {
    const requestIsCurrent = () => requestId === undefined || visionRequestLifecycleRef.current.isCurrent(requestId)
    if (!requestIsCurrent()) return false
    const contentWidth = Math.round(barRect.width)   // 长度不变
    const contentHeight = READY_BAR_H
    const width = contentWidth + FLOATING_PADDING * 2
    const height = contentHeight + FLOATING_PADDING * 2
    const slot = computeTopSlot(viewport.w, viewport.h, contentWidth)
    const fromOrigin = {
      x: Math.round(winOrigin.x + barRect.x - FLOATING_PADDING),
      y: Math.round(winOrigin.y + barRect.y - FLOATING_PADDING),
    }
    const targetOrigin = {
      x: Math.round(winOrigin.x + slot.x - FLOATING_PADDING),
      y: Math.round(winOrigin.y + slot.y - FLOATING_PADDING),
    }
    const flySeq = ++nativeFlySeqRef.current

    fullscreenMetricsRef.current = metrics
    flushSync(() => {
      // 必须在这一次提交里就离开 select 态。
      // 否则「select 时按 viewport 重算选区条」那个 effect 会在下面
      // setViewport 缩到小窗尺寸时触发，用 480×56 的视口重算 SELECT_W，
      // 输入条宽度会从 820 缩到 480 —— 飞着飞着就变短了。
      setStage('ready')
      beforeFlush?.()
      setFloatingRebased(false)
      setNativeHitRegionActive(false)
      setHitRegionRect(null)
      setPanelDragActive(false)
      floatingSizeRef.current = null
      setBarNoTransition(true)
      setBarRebaseHidden(true)
      setBarInFlight(false)
      setJellyActive(false)
      setSelectBarCollapsed(false)
      setBarFlyOffset({ x: 0, y: 0 })
      setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
    })

    try {
      if (flySeq !== nativeFlySeqRef.current || !requestIsCurrent()) return false
      await api.visionSetHitRegion(null)
      if (flySeq !== nativeFlySeqRef.current || !requestIsCurrent()) return false
      const applied = await setVisionFloatingWithRetry({
        x: fromOrigin.x,
        y: fromOrigin.y,
        width,
        height,
        hasScreenshot,
      }, () => flySeq === nativeFlySeqRef.current && requestIsCurrent())
      if (!applied || flySeq !== nativeFlySeqRef.current || !requestIsCurrent()) return false
      flushSync(() => {
        setFloatingRebased(true)
        setWinOrigin(fromOrigin)
        setViewport({ w: width, h: height })
        setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
        setBarRebaseHidden(false)
        floatingSizeRef.current = { width, height, hasScreenshot }
      })

      await api.visionFlyFloating({
        from: fromOrigin,
        to: targetOrigin,
        width,
        height,
        hasScreenshot,
        durationMs: NATIVE_FLOATING_FLY_MS,
      })
      if (flySeq !== nativeFlySeqRef.current || !requestIsCurrent()) return false

      flushSync(() => {
        setWinOrigin(targetOrigin)
        setViewport({ w: width, h: height })
        setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
        setBarRebaseHidden(false)
        setBarNoTransition(false)
        setJellyActive(false)
        floatingSizeRef.current = { width, height, hasScreenshot }
      })
      if (
        flySeq === nativeFlySeqRef.current
        && requestIsCurrent()
        && shouldRunVisionLandingJelly()
      ) {
        startLandingJelly()
      }
      return true
    } catch (err) {
      if (flySeq !== nativeFlySeqRef.current || !requestIsCurrent()) return false
      console.error('[vision-floating] fly to top slot failed:', err)
      flushSync(() => {
        setFloatingRebased(false)
        setBarRebaseHidden(false)
        setBarNoTransition(false)
        setBarRect({ x: Math.round(slot.x), y: Math.round(slot.y), width: contentWidth })
      })
      return false
    }
  }, [barRect, metrics, startLandingJelly, viewport, winOrigin])

  const enterTextOnlyFloatingAnswer = useCallback(async (nextMessages: ExplainMessage[], requestId: string) => {
    // 先只把输入条飞上去（此时还是单条高度），落地后再置 answering，
    // 让回答面板从落点向下展开 —— 而不是边飞边长高。
    const ok = await flyBarToTopSlot(requestId)
    if (!isVisionRequestCurrent(requestId)) return false
    flushSync(() => {
      setMessages(nextMessages)
      setStage('answering')
      setStreaming(true)
    })
    if (ok) focusVisionInput([30, 120, 260])
    return ok
  }, [flyBarToTopSlot, focusVisionInput, isVisionRequestCurrent])

  // 优化提示词：全程不动输入框。原文留在 input 里，结果进预览卡，
  // 由用户决定是否「采纳」。优化中再点一次按钮 = 取消。
  const handleOptimizeVisionPrompt = useCallback(async () => {
    if (promptOptimizing) {
      cancelPromptOptimization()
      inputRef.current?.focus({ preventScroll: true })
      return
    }
    const source = input.trim()
    if (!source || streaming) return

    const seq = ++promptOptimizeSeqRef.current
    setPromptOptimizing(true)
    setHistoryOpen(false)
    setPromptPreviewSource(source)
    setPromptPreviewText('')
    setPromptPreviewStatus('loading')

    // 点了优化就说明用户此刻在处理文字，不是在选截图区域。
    // 把全屏截图遮罩（含 Windows 的冻结桌面层）收成悬浮小窗，
    // 否则用户要盯着一张冻住的假桌面读优化结果。
    // stage 必须一并切到 ready：isFloatingLayout 和悬浮尺寸 effect 都假定
    // select 态等于全屏，停在 select 会让窗口不跟随卡片高度。
    if (stageRef.current === 'select' || !floatingRebased) {
      const ok = await flyBarToTopSlot(undefined, undefined, hasScreenshot)
      if (seq !== promptOptimizeSeqRef.current) return
      if (ok) focusVisionInput([30, 120])
    }

    try {
      const result = await api.optimizePrompt(source)
      if (seq !== promptOptimizeSeqRef.current) return
      setPromptPreviewText(extractOptimizedPromptForInput(result) || source)
      setPromptPreviewStatus('ready')
      setPromptOptimizing(false)
    } catch (err) {
      if (seq !== promptOptimizeSeqRef.current) return
      console.error('[vision-prompt-optimizer] failed:', err)
      setPromptPreviewStatus('error')
      setPromptOptimizing(false)
    }
  }, [cancelPromptOptimization, floatingRebased, flyBarToTopSlot, focusVisionInput, hasScreenshot, input, promptOptimizing, streaming])

  const acceptOptimizedPrompt = useCallback(() => {
    const next = promptPreviewText.trim()
    promptOptimizeSeqRef.current += 1
    setPromptPreviewStatus('idle')
    setPromptPreviewSource('')
    setPromptPreviewText('')
    setPromptOptimizing(false)
    if (next) setInput(next)
    inputRef.current?.focus({ preventScroll: true })
  }, [promptPreviewText])

  const discardOptimizedPrompt = useCallback(() => {
    cancelPromptOptimization()
    inputRef.current?.focus({ preventScroll: true })
  }, [cancelPromptOptimization])

  const handleSend = async () => {
    if (streaming) return
    const question = input.trim()
    const allowBlankImageAnalysis = (
      !question
      && mode === 'chat'
      && stageRef.current === 'ready'
      && messages.length === 0
      && !!imageIdRef.current
    )
    if (!question && !allowBlankImageAnalysis) return
    if (!await ensureVisionStreamListener()) return
    const requestId = visionRequestLifecycleRef.current.begin()
    visionTerminalErrorRef.current = null
    const effectiveQuestion = question || defaultImageAnalysisQuestion(lang)
    setHistoryOpen(false)
    // 发送即视为放弃这次优化建议：预览卡和答案面板都挂在悬浮条正下方，
    // 不收掉会直接叠在一起。
    cancelPromptOptimization()
    setInput('')

    // 先进入 sending UI，再做合成/注册，避免这段异步窗口被 Esc 关闭掉。
    const isFirstTurn = messages.length === 0
    const ctx = (isFirstTurn && mode === 'chat') ? selectionText.trim() : ''
    const userContent = ctx
      ? (lang === 'zh'
          ? `[已选文本]\n${ctx}\n\n[用户问题]\n${effectiveQuestion}`
          : `[Selected Text]\n${ctx}\n\n[Question]\n${effectiveQuestion}`)
      : effectiveQuestion
    const userMsg: ExplainMessage = { role: 'user', content: userContent }
    const placeholder: ExplainMessage = { role: 'assistant', content: '' }
    const sendMessages: ExplainMessage[] = [...messages, userMsg]
    const nextMessages = [...sendMessages, placeholder]
    chatAutoFollowRef.current = true
    resetVisionStreamBuffer()
    preparingSendRef.current = true
    const textOnlyFloating = (
      mode === 'chat'
      && !imageIdRef.current
      && !capturedFrame
      && !floatingRebased
    )
    if (textOnlyFloating) {
      await enterTextOnlyFloatingAnswer(nextMessages, requestId)
      if (!isVisionRequestCurrent(requestId)) return
    } else {
      flushSync(() => {
        setMessages(nextMessages)
        setStage('answering')
        setStreaming(true)
      })
    }

    // 默认沿用当前 image_id;若有箭头则先合成 + 注册新图,把后续 ask 切到合成版
    try {
      if (!isVisionRequestCurrent(requestId)) return
      let effectiveImageId = imageIdRef.current
      if (arrows.length > 0 && imagePreview && capturedFrame) {
        try {
          const base64 = await composeAnnotatedImage(
            imagePreview,
            arrows,
            capturedFrame.width,
            capturedFrame.height,
          )
          if (!isVisionRequestCurrent(requestId)) return
          const result = await api.visionRegisterAnnotatedImage(base64)
          if (!isVisionRequestCurrent(requestId)) {
            if (result.success && result.imageId) {
              void api.visionDeleteTemporaryImage(result.imageId).catch(err => {
                console.error('[vision-arrow] stale image cleanup failed:', err)
              })
            }
            return
          }
          if (result.success && result.imageId) {
            const replacedImageId = effectiveImageId
            effectiveImageId = result.imageId
            imageIdRef.current = result.imageId
            if (replacedImageId && replacedImageId !== result.imageId) {
              void api.visionDeleteTemporaryImage(replacedImageId).catch(err => {
                console.error('[vision-arrow] replaced image cleanup failed:', err)
              })
            }
            setImagePreview(`data:image/png;base64,${base64}`)
            setArrows([])
            setDraftArrow(null)
            setDrawMode(false)
          } else {
            console.warn('[vision-arrow] register annotated image failed:', result.error)
          }
        } catch (err) {
          if (isVisionRequestCurrent(requestId)) {
            console.warn('[vision-arrow] compose failed, fallback to original:', err)
          }
        }
      }
      if (!isVisionRequestCurrent(requestId)) return
      preparingSendRef.current = false
      const result = await api.visionAsk(effectiveImageId || '', sendMessages, requestId)
      if (!isVisionRequestCurrent(requestId) || !visionRequestLifecycleRef.current.matchesResult(requestId, result)) return
      if (!visionRequestLifecycleRef.current.acceptResult(requestId, result.requestId)) return
      clearVisionStreamFlushTimer()
      flushVisionStreamBuffer(true)
      if (!result.success) {
        const errText = `${t.visionError}: ${result.error}`
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const content = appendVisionError(last.content, errText)
          return [...prev.slice(0, -1), { ...last, content }]
        })
      } else if (result.response) {
        // 非流式:把完整答案塞进占位 assistant;流式情况已在 onVisionStream 累积,避免覆盖
        const canonicalResponse = result.response
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const content = mergeVisionResponse(last.content, canonicalResponse)
          if (content === last.content) return prev
          return [...prev.slice(0, -1), { ...last, content }]
        })
      }
    } catch (err) {
      if (!isVisionRequestCurrent(requestId)) return
      if (!visionRequestLifecycleRef.current.settleError(requestId)) return
      clearVisionStreamFlushTimer()
      flushVisionStreamBuffer(true)
      const msg = err instanceof Error ? err.message : String(err)
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant') return prev
        return [...prev.slice(0, -1), { ...last, content: appendVisionError(last.content, `${t.visionError}: ${msg}`) }]
      })
    } finally {
      if (!visionRequestLifecycleRef.current.canFinalize(requestId)) return
      preparingSendRef.current = false
      // ref 在 setStreaming(false) 之前置 true,让持久化 effect 在本次 rerun 中识别这是"流刚结束"路径
      if (!closingStreamRef.current) {
        justFinishedStreamRef.current = true
      }
      setStreaming(false)
      visionTerminalErrorRef.current = null
    }
  }

  const handleStop = async () => {
    const stopSequence = invalidateVisionRequest()
    try { await api.visionCancelStream() } catch (err) { console.error(err) }
    if (!visionRequestLifecycleRef.current.isCurrentInvalidation(stopSequence)) return
    clearVisionStreamFlushTimer()
    flushVisionStreamBuffer(true)
    // 用户主动取消但已经流出部分内容，也持久化 —— 关掉再开历史能接着问
    justFinishedStreamRef.current = true
    setStreaming(false)
  }

  const copyTextWithFeedback = async (text: string, target: CopyTarget) => {
    if (!text.trim()) return
    const sequence = beginCopyOperation()
    const ok = await copyToClipboard(text)
    if (!copyOperationIsCurrent(sequence)) return
    const currentText = target === 'answer'
      ? [...messagesRef.current].reverse().find(message => message.role === 'assistant' && message.content)?.content ?? ''
      : target === 'original'
        ? translateOriginalRef.current
        : translateTextRef.current
    if (currentText !== text) return
    if (!ok) {
      reportCopyFailure(t.visionCopyFailed)
      return
    }
    copiedTextRef.current = { target, text }
    setCopiedTarget(target)
    copyTimeoutRef.current = setTimeout(() => {
      if (copyOperationIsCurrent(sequence)) setCopiedTarget(null)
      copyTimeoutRef.current = null
    }, 2000)
  }

  const playSpeechDataUrl = useCallback((dataUrl: string, seq: number) => {
    return new Promise<void>((resolve, reject) => {
      if (speechSeqRef.current !== seq) {
        resolve()
        return
      }
      const audio = new Audio(dataUrl)
      speechAudioRef.current = audio
      audio.onended = () => {
        if (speechAudioRef.current === audio) speechAudioRef.current = null
        resolve()
      }
      audio.onpause = () => {
        if (!audio.ended) resolve()
      }
      audio.onerror = () => {
        if (speechAudioRef.current === audio) speechAudioRef.current = null
        reject(new Error('Audio playback failed'))
      }
      audio.play().catch(reject)
    })
  }, [])

  const speakText = useCallback(async (text: string, target: SpeechTarget) => {
    if (!text.trim()) return
    const isCurrentTarget = speakingTarget === target || speechLoadingTarget === target
    stopSpeechPlayback()
    if (isCurrentTarget) return

    const seq = speechSeqRef.current
    const chunks = splitSpeechText(text)
    if (!chunks.length) return
    setSpeechErrorTarget(null)
    setSpeechErrorAnnouncement('')
    setSpeechLoadingTarget(target)

    try {
      for (const chunk of chunks) {
        if (speechSeqRef.current !== seq) return
        const result = await api.synthesizeSpeech(chunk)
        if (speechSeqRef.current !== seq) return
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Speech synthesis failed')
        }
        setSpeechLoadingTarget(null)
        setSpeakingTarget(target)
        await playSpeechDataUrl(result.data, seq)
      }
    } catch (err) {
      console.error('Speech playback failed:', err)
      const failure = resolveVisionSpeechFailure(seq, speechSeqRef.current, target, t.visionSpeechFailed)
      if (failure) {
        setSpeechErrorTarget(failure.target)
        setSpeechErrorAnnouncement(failure.announcement)
      }
    } finally {
      if (speechSeqRef.current === seq) {
        speechAudioRef.current = null
        setSpeechLoadingTarget(null)
        setSpeakingTarget(null)
      }
    }
  }, [playSpeechDataUrl, speakingTarget, speechLoadingTarget, stopSpeechPlayback, t.visionSpeechFailed])

  const handleCopy = async () => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content)
    if (!lastAssistant) return
    await copyTextWithFeedback(lastAssistant.content, 'answer')
  }

  // 点击历史项：把当前会话恢复到该 item（image / appLabel / messages / capturedFrame）
  // 取消任何正在跑的流，避免后端继续 emit delta 灌入新恢复的 messages（如果新旧 imageId 巧合相同会污染）
  const restoreHistory = async (item: HistoryItem) => {
    invalidateVisionRequest()
    beginCopyOperation()
    setHistoryOpen(false)
    cancelPromptOptimization()
    stopSpeechPlayback()
    if (streaming) {
      void api.visionCancelStream().catch(err => console.error(err))
    }
    resetVisionStreamBuffer()
    setVisionCursorPassthrough(false)
    // 纯文字会话的 id 是自造的，后端没有对应图片。
    // 这里必须把 imageIdRef 置空，否则恢复后再提问会带着这个假 id 调 vision_ask，
    // resolve_explain_image_path 找不到图直接报错。
    const restoreTextOnly = !!item.textOnly
    imageIdRef.current = restoreTextOnly ? '' : item.id
    textSessionIdRef.current = restoreTextOnly ? item.id : ''
    chatAutoFollowRef.current = true
    justFinishedStreamRef.current = false
    const restoreSeq = ++nativeFlySeqRef.current
    if (barFlightTimerRef.current) {
      clearTimeout(barFlightTimerRef.current)
      barFlightTimerRef.current = null
    }
    panelDraggingRef.current = false
    fullscreenMetricsRef.current = metrics

    const wasFloating = floatingRebased
    const contentWidth = Math.round(barRect.width || metrics.READY_W)
    const contentHeight = Math.round(READY_BAR_H + FLOATING_GAP + metrics.ANSWER_H)
    const width = contentWidth + FLOATING_PADDING * 2
    const height = contentHeight + FLOATING_PADDING * 2
    const localX = wasFloating
      ? barRect.x
      : Math.max(16, Math.min(viewport.w - contentWidth - 16, barRect.x))
    const localY = wasFloating
      ? barRect.y
      : Math.max(16, Math.min(viewport.h - contentHeight - 16, barRect.y))
    let currentOrigin = winOrigin
    if (wasFloating) {
      try {
        const [position, scale] = await Promise.all([
          getCurrentWindow().innerPosition(),
          getCurrentWindow().scaleFactor(),
        ])
        const factor = scale || 1
        currentOrigin = { x: position.x / factor, y: position.y / factor }
        setWinOrigin(currentOrigin)
        setWindowMoveRevision(prev => prev + 1)
      } catch (error) {
        console.error('[vision-history] current window origin failed:', error)
      }
    }
    if (restoreSeq !== nativeFlySeqRef.current) return
    const origin = {
      x: Math.round(currentOrigin.x + localX - FLOATING_PADDING),
      y: Math.round(currentOrigin.y + localY - FLOATING_PADDING),
    }

    flushSync(() => {
      setMode('chat')
      setImagePreview(item.imagePreview)
      setAppLabel(item.appLabel)
      setInput('')
      setSelectionText('')
      setMessages(item.messages)
      setCapturedFrame(item.capturedFrame)
      setStreaming(false)
      setFloatingRebased(false)
      setNativeHitRegionActive(false)
      setHitRegionRect(null)
      setPanelDragActive(false)
      setBarNoTransition(true)
      setBarFlyOffset({ x: 0, y: 0 })
      setBarRebaseHidden(true)
      setBarInFlight(false)
      setJellyActive(false)
      setSelectBarCollapsed(false)
      setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
      floatingSizeRef.current = null
      setStage('answering')
    })
    selectionReqIdRef.current++
    focusReqIdRef.current++

    try {
      await api.visionSetHitRegion(null)
      const applied = await setVisionFloatingWithRetry({
        x: origin.x,
        y: origin.y,
        width,
        height,
        hasScreenshot: !restoreTextOnly,
      }, () => restoreSeq === nativeFlySeqRef.current)
      if (!applied || restoreSeq !== nativeFlySeqRef.current) return
      flushSync(() => {
        setFloatingRebased(true)
        setWinOrigin(origin)
        setViewport({ w: width, h: height })
        setBarRect({ x: FLOATING_PADDING, y: FLOATING_PADDING, width: contentWidth })
        setBarRebaseHidden(false)
        setBarNoTransition(false)
        floatingSizeRef.current = { width, height, hasScreenshot: !restoreTextOnly }
      })
      focusVisionInput([30, 120, 260])
    } catch (err) {
      console.error('[vision-history] native floating restore failed:', err)
      if (restoreSeq !== nativeFlySeqRef.current) return
      flushSync(() => {
        setFloatingRebased(false)
        setBarRebaseHidden(false)
        setBarNoTransition(false)
        setBarRect({ x: Math.round(localX), y: Math.round(localY), width: contentWidth })
      })
      focusVisionInput([50, 140, 260])
    }
  }

  const relTime = (ts: number): string => {
    const diff = Date.now() - ts
    const m = Math.floor(diff / 60000)
    if (m < 1) return lang === 'zh' ? '刚刚' : 'just now'
    if (m < 60) return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`
    return lang === 'zh' ? `${Math.floor(h / 24)} 天前` : `${Math.floor(h / 24)}d ago`
  }

  useEffect(() => () => {
    copySequenceRef.current += 1
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    if (copyErrorTimeoutRef.current) clearTimeout(copyErrorTimeoutRef.current)
    if (captureWarningTimeoutRef.current) clearTimeout(captureWarningTimeoutRef.current)
    invalidateVisionSurface()
    invalidateVisionRequest()
    if (barFlightTimerRef.current) clearTimeout(barFlightTimerRef.current)
    if (translateEditDebounceRef.current) clearTimeout(translateEditDebounceRef.current)
    translateEditSeqRef.current++
    promptOptimizeSeqRef.current++
    stopSpeechPlayback()
    setVisionCursorPassthrough(false)
  }, [invalidateVisionRequest, invalidateVisionSurface, setVisionCursorPassthrough, stopSpeechPlayback])

  useEffect(() => {
    if (!historyOpen) return
    focusReqIdRef.current += 1
    const focusFrame = window.requestAnimationFrame(() => {
      const target = historyDropdownRef.current?.querySelector<HTMLElement>('button') ?? historyDropdownRef.current
      target?.focus()
    })
    const onDown = (e: MouseEvent) => {
      if (!historyPanelRef.current?.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      focusReqIdRef.current += 1
      setHistoryOpen(false)
      window.requestAnimationFrame(() => historyTriggerRef.current?.focus())
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [historyOpen])

  const showThumb = stage !== 'select' && (imagePreview || appLabel)
  const canSendBlankImageAnalysis = mode === 'chat' && stage === 'ready' && messages.length === 0 && capturedFrame !== null
  const canOptimizePrompt = !!input.trim() && !streaming && !promptOptimizing
  const sendDisabled = streaming || promptOptimizing || (!input.trim() && !canSendBlankImageAnalysis)
  const showBar = mode === 'chat'
  const hideSelectBar = mode === 'chat' && stage === 'select' && selectBarCollapsed
  const showTranslateCard = mode === 'translate' && (stage === 'translating' || stage === 'translated')
  // 提示词预览卡只在 chat 模式的悬浮条下方出现；answering 期间不展示，避免和答案面板抢位置
  const showPromptPreview = mode === 'chat' && promptPreviewStatus !== 'idle'
  const readonlyAiOcrOriginal = translateOcrMethod === 'ai'
  const methodSwitching = ocrMethodSwitching || translationMethodSwitching
  const methodSelectClass = 'ml-auto shrink-0 h-5 max-w-[122px] rounded-md border border-black/[0.06] bg-white/80 px-1.5 text-[10.5px] font-medium text-neutral-500 outline-none hover:text-neutral-700 hover:border-black/[0.12] disabled:opacity-60 dark:border-white/[0.08] dark:bg-neutral-900/70 dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:border-white/[0.14]'
  const ocrMethodOptions = useMemo<{ value: ScreenshotOcrMethod; label: string }[]>(() => [
    { value: 'ai', label: t.screenshotOcrAI },
    { value: 'baidu', label: t.screenshotOcrBaidu },
    { value: 'chaoxing', label: t.screenshotOcrChaoxing },
  ], [t])
  const translationMethodOptions = useMemo<{ value: ScreenshotTranslationMethod; label: string }[]>(() => [
    { value: 'ai', label: t.screenshotTranslationAI },
    { value: 'google', label: t.screenshotTranslationGoogle },
    { value: 'baidu', label: t.screenshotTranslationBaidu },
    { value: 'tencent', label: t.screenshotTranslationTencent },
    { value: 'bing', label: t.screenshotTranslationBing },
    { value: 'bing2', label: t.screenshotTranslationBing2 },
    { value: 'yandex', label: t.screenshotTranslationYandex },
    { value: 'caiyun2', label: t.screenshotTranslationCaiyun2 },
    { value: 'microsoft', label: t.screenshotTranslationMicrosoft },
  ], [t])
  // 浮动布局生效条件：原生窗口已经真的缩成小浮窗。
  // 截图后和无截图纯文本对话都走同一套原生浮窗拖动，避免全屏透明层参与鼠标事件。
  const isFloatingLayout = floatingRebased && stage !== 'select'
  const barMotionActive = shouldPromoteVisionBarLayer(
    barInFlight,
    jellyActive,
    barIntro,
    hideSelectBar,
    barFlyOffset.x,
    barFlyOffset.y,
  )
  const stableAnswerHeight = isFloatingLayout
    ? fullscreenMetricsRef.current?.ANSWER_H || metrics.ANSWER_H
    : metrics.ANSWER_H

  // 悬浮条在 select 态贴着屏幕底部，卡片再往下展开会跑出可视区。
  // 悬浮布局固定向下（窗口会跟着 resize）；全屏态按剩余空间选方向，同历史下拉的逻辑。
  const promptPreviewPlaceAbove = useMemo(() => {
    if (!showPromptPreview) return false
    if (isFloatingLayout) return false
    const need = (promptPreviewCardHeight ?? PROMPT_PREVIEW_MAX_H) + PROMPT_PREVIEW_GAP + 16
    const spaceBelow = viewport.h - (barRect.y + READY_BAR_H)
    return spaceBelow < need && barRect.y > spaceBelow
  }, [barRect.y, isFloatingLayout, promptPreviewCardHeight, showPromptPreview, viewport.h])

  // 预览卡打开时 esc 只收卡片，不关整个窗口。
  // 用捕获阶段 + stopImmediatePropagation 抢在窗口级 esc 之前，做法同下面的 drawMode。
  useEffect(() => {
    if (!showPromptPreview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      discardOptimizedPrompt()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [discardOptimizedPrompt, showPromptPreview])

  // 提示词预览卡高度自适应：卡片内容长度不定，必须实测后并进悬浮窗尺寸，
  // 否则窗口高度不够，卡片会被原生窗口边界裁掉。
  const measurePromptPreviewCardHeight = useCallback(() => {
    if (!showPromptPreview) {
      setPromptPreviewCardHeight(prev => (prev === null ? prev : null))
      return
    }
    const rect = promptPreviewCardRef.current?.getBoundingClientRect()
    const next = rect && rect.height >= 1 ? Math.ceil(rect.height) : null
    setPromptPreviewCardHeight(prev => {
      if (prev === next) return prev
      if (prev !== null && next !== null && Math.abs(prev - next) < 1) return prev
      return next
    })
  }, [showPromptPreview])

  // textarea 自动撑高：不做的话内容多了只会出现内部滚动条，
  // 卡片测出来永远是初始高度，悬浮窗也就不会跟着长。
  useLayoutEffect(() => {
    const el = promptPreviewEditorRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, PROMPT_PREVIEW_MAX_H - PROMPT_PREVIEW_CHROME_H)}px`
  }, [promptPreviewStatus, promptPreviewText])

  useLayoutEffect(() => {
    measurePromptPreviewCardHeight()
  }, [measurePromptPreviewCardHeight, promptPreviewStatus, promptPreviewText, promptPreviewSource])

  useEffect(() => {
    if (!showPromptPreview) {
      setPromptPreviewCardHeight(prev => (prev === null ? prev : null))
      return
    }
    const el = promptPreviewCardRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      measurePromptPreviewCardHeight()
      return
    }
    const observer = new ResizeObserver(() => measurePromptPreviewCardHeight())
    observer.observe(el)
    return () => observer.disconnect()
  }, [measurePromptPreviewCardHeight, showPromptPreview])

  // 答案区展开方向 + 高度自适应：
  // 1) 下方空间够 ANSWER_H → 向下，目标高
  // 2) 上方空间够 → 向上，目标高
  // 3) 都不够 → 选大的那侧，高度收缩为该侧可用空间（最少 180，避免太矮）
  const answerLayout = useMemo(() => {
    if (isFloatingLayout) {
      return { placeAbove: false, height: stableAnswerHeight }
    }
    const target = stableAnswerHeight
    const spaceBelow = viewport.h - (barRect.y + READY_BAR_H + 8) - 16
    const spaceAbove = barRect.y - 8 - 16
    if (spaceBelow >= target) return { placeAbove: false, height: target }
    if (spaceAbove >= target) return { placeAbove: true, height: target }
    if (spaceAbove > spaceBelow) {
      return { placeAbove: true, height: Math.max(180, spaceAbove) }
    }
    return { placeAbove: false, height: Math.max(180, spaceBelow) }
  }, [barRect, isFloatingLayout, stableAnswerHeight, viewport.h])

  const historyDropdownLayout = useMemo(() => {
    if (isFloatingLayout) {
      return { openBelow: true, maxHeight: HISTORY_PANEL_MAX_H }
    }
    const buttonTop = barRect.y + (READY_BAR_H - HISTORY_BUTTON_ESTIMATED_H) / 2
    const buttonBottom = buttonTop + HISTORY_BUTTON_ESTIMATED_H
    const viewportPadding = 8
    const spaceAbove = Math.max(0, buttonTop - HISTORY_PANEL_GAP - viewportPadding)
    const spaceBelow = Math.max(0, viewport.h - buttonBottom - HISTORY_PANEL_GAP - viewportPadding)
    const openBelow = spaceAbove < HISTORY_PANEL_MAX_H && spaceBelow > spaceAbove
    const available = Math.max(HISTORY_PANEL_MIN_H, openBelow ? spaceBelow : spaceAbove)

    return {
      openBelow,
      maxHeight: Math.min(HISTORY_PANEL_MAX_H, Math.floor(available)),
    }
  }, [barRect.y, isFloatingLayout, viewport.h])

  // 全屏 overlay 只保留可交互面板区域，避免透明 WebView 拦截桌面点击。
  // 截图路径有 capturedFrame；无截图直接提问时没有 capturedFrame，但 answering 面板同样需要穿透。
  const passThroughOverlay = stage !== 'select'
    && !floatingRebased
    && !barRebaseHidden
    && (capturedFrame !== null || (mode === 'chat' && stage === 'answering'))
  const passThroughPanelRect = useMemo<Rect | null>(() => {
    if (!passThroughOverlay) return null

    let x = barRect.x
    let y = barRect.y
    let width = barRect.width
    let height = READY_BAR_H

    if (mode === 'chat' && showPromptPreview) {
      // 预览卡固定挂在悬浮条下方，穿透面板要一并加高，否则卡片区域收不到鼠标
      height += PROMPT_PREVIEW_GAP + (promptPreviewCardHeight ?? PROMPT_PREVIEW_MAX_H)
    } else if (mode === 'chat' && stage === 'answering') {
      const answerHeight = FLOATING_GAP + answerLayout.height
      if (answerLayout.placeAbove) {
        y -= answerHeight
      }
      height += answerHeight
    } else if (mode === 'translate' && (stage === 'translating' || stage === 'translated')) {
      height = !keepFullscreen
        ? READY_BAR_H + 8 + stableAnswerHeight
        : Math.min(viewport.h - 32, READY_BAR_H + 8 + stableAnswerHeight)
    }

    if (historyOpen && mode === 'chat') {
      const buttonRect = historyPanelRef.current?.getBoundingClientRect()
      const historyRight = buttonRect?.right ?? (barRect.x + barRect.width)
      const historyX = Math.max(
        8,
        Math.min(viewport.w - HISTORY_PANEL_W - 8, historyRight - HISTORY_PANEL_W),
      )
      const historyH = historyDropdownLayout.maxHeight
      const historyY = historyDropdownLayout.openBelow
        ? Math.min(viewport.h - historyH - 8, barRect.y + READY_BAR_H + HISTORY_PANEL_GAP)
        : Math.max(8, barRect.y - HISTORY_PANEL_GAP - historyH)
      const left = Math.min(x, historyX)
      const top = Math.min(y, historyY)
      const right = Math.max(x + width, historyX + HISTORY_PANEL_W)
      const bottom = Math.max(y + height, historyY + historyH)
      x = left
      y = top
      width = right - left
      height = bottom - top
    }

    if (drawMode && capturedFrame) {
      const left = Math.min(x, capturedFrame.x)
      const top = Math.min(y, capturedFrame.y)
      const right = Math.max(x + width, capturedFrame.x + capturedFrame.width)
      const bottom = Math.max(y + height, capturedFrame.y + capturedFrame.height)
      x = left
      y = top
      width = right - left
      height = bottom - top
    }

    const margin = HIT_REGION_MARGIN
    return {
      x: x - margin,
      y: y - margin,
      width: width + margin * 2,
      height: height + margin * 2,
    }
  }, [
    answerLayout,
    barRect,
    capturedFrame,
    drawMode,
    historyDropdownLayout,
    historyOpen,
    keepFullscreen,
    mode,
    passThroughOverlay,
    promptPreviewCardHeight,
    showPromptPreview,
    stableAnswerHeight,
    stage,
    viewport.w,
    viewport.h,
  ])

  const updateHitRegionRect = useCallback(() => {
    if (!passThroughOverlay) {
      setHitRegionRect(prev => (prev ? null : prev))
      return
    }

    const rects: Rect[] = []
    const addElementRect = (el: HTMLElement | null) => {
      if (!el) return
      const rect = domRectToRect(el.getBoundingClientRect())
      if (rect) rects.push(rect)
    }

    if (showBar) {
      addElementRect(barPanelRef.current)
      if (stage === 'answering') addElementRect(answerPanelRef.current)
      if (historyOpen) {
        addElementRect(historyPanelRef.current)
        addElementRect(historyDropdownRef.current)
      }
    }
    if (showTranslateCard) addElementRect(translateCardRef.current)
    if (showPromptPreview) addElementRect(promptPreviewCardRef.current)
    if (drawMode && capturedFrame) rects.push(capturedFrame)

    const union = unionRects(rects)
    const next = clampRect(union ? inflateRect(union, HIT_REGION_MARGIN) : null, viewport)
    setHitRegionRect(prev => (rectEquals(prev, next) ? prev : next))
  }, [
    capturedFrame,
    drawMode,
    historyOpen,
    passThroughOverlay,
    showBar,
    showPromptPreview,
    showTranslateCard,
    stage,
    viewport,
  ])

  useLayoutEffect(() => {
    updateHitRegionRect()
  }, [
    updateHitRegionRect,
    answerLayout,
    promptPreviewCardHeight,
    promptPreviewStatus,
    barInFlight,
    barFlyOffset,
    barIntro,
    barRect,
    messages,
    stableAnswerHeight,
    streaming,
    translateError,
    translateOriginalError,
    translateMethod,
    translateOriginal,
    translateOcrMethod,
    translateRetranslating,
    translateText,
    ocrMethodSwitching,
    translationMethodSwitching,
  ])

  useEffect(() => {
    if (!passThroughOverlay) return
    const observed = [
      barPanelRef.current,
      answerPanelRef.current,
      translateCardRef.current,
      promptPreviewCardRef.current,
      historyPanelRef.current,
      historyDropdownRef.current,
    ].filter((el): el is HTMLDivElement => el !== null)
    if (observed.length === 0 || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => updateHitRegionRect())
    observed.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [
    passThroughOverlay,
    showBar,
    showPromptPreview,
    showTranslateCard,
    stage,
    historyOpen,
    updateHitRegionRect,
  ])

  const activePassThroughRect = useMemo<Rect | null>(() => {
    if (!passThroughOverlay) return null
    const rects = (barInFlight
      ? [hitRegionRect, passThroughPanelRect]
      : [hitRegionRect || passThroughPanelRect]
    ).filter((rect): rect is Rect => rect !== null)
    const union = unionRects(rects)
    return union ? clampRect(union, viewport) : null
  }, [
    barInFlight,
    hitRegionRect,
    passThroughOverlay,
    passThroughPanelRect,
    viewport,
  ])

  useEffect(() => {
    let cancelled = false
    const rect = activePassThroughRect
    if (panelDragActive) {
      setNativeHitRegionActive(false)
      void api.visionSetHitRegion(null).catch(err => console.error('[vision-floating] clear hit region failed:', err))
      return
    }
    if (!passThroughOverlay || !rect) {
      setNativeHitRegionActive(false)
      void api.visionSetHitRegion(null).catch(err => console.error('[vision-floating] clear hit region failed:', err))
      return
    }

    void api.visionSetHitRegion(rect)
      .then((active) => {
        if (cancelled) return
        setNativeHitRegionActive(active)
        if (active) setVisionCursorPassthrough(false)
      })
      .catch((err) => {
        if (!cancelled) {
          setNativeHitRegionActive(false)
          console.error('[vision-floating] hit region failed:', err)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    activePassThroughRect,
    panelDragActive,
    passThroughOverlay,
    setVisionCursorPassthrough,
    windowMoveRevision,
  ])

  useEffect(() => {
    if (panelDragActive) {
      setVisionCursorPassthrough(false)
      return
    }
    if (nativeHitRegionActive) {
      setVisionCursorPassthrough(false)
      return
    }
    if (!passThroughOverlay || !activePassThroughRect) {
      setVisionCursorPassthrough(false)
      return
    }

    let cancelled = false
    let busy = false
    const insidePanel = (point: Point) => (
      point.x >= activePassThroughRect.x
      && point.x <= activePassThroughRect.x + activePassThroughRect.width
      && point.y >= activePassThroughRect.y
      && point.y <= activePassThroughRect.y + activePassThroughRect.height
    )

    const tick = async () => {
      if (busy) return
      busy = true
      try {
        if (panelDraggingRef.current) {
          setVisionCursorPassthrough(false)
          return
        }
        const cursor = await api.visionCursorPosition()
        if (cancelled) return
        if (!cursor) {
          setVisionCursorPassthrough(false)
          return
        }
        const localPoint = { x: cursor.x - winOrigin.x, y: cursor.y - winOrigin.y }
        setVisionCursorPassthrough(!insidePanel(localPoint))
      } catch (err) {
        if (!cancelled) {
          setVisionCursorPassthrough(false)
          console.error('[vision-floating] cursor passthrough polling failed:', err)
        }
      } finally {
        busy = false
      }
    }

    void tick()
    const interval = window.setInterval(() => { void tick() }, 40)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      setVisionCursorPassthrough(false)
    }
  }, [
    activePassThroughRect,
    nativeHitRegionActive,
    panelDragActive,
    passThroughOverlay,
    setVisionCursorPassthrough,
    winOrigin.x,
    winOrigin.y,
  ])

  useEffect(() => {
    if (stage === 'select') return
    if (!floatingRebased) return
    if (barNoTransition) return
    // OCR 的窗口高度由 ScreenPilot 适配层根据内容一次性扩展。这里若再观察
    // 卡片高度并回写同一个 HWND，会让视口高度与卡片高度互相反馈而持续振荡。
    if (!shouldReactOwnVisionFloatingResize(mode)) return

    let cancelled = false

    const w = barRect.width + FLOATING_PADDING * 2
    let h = READY_BAR_H + FLOATING_PADDING * 2

    if (stage === 'answering') {
      h += FLOATING_GAP + answerLayout.height
    }

    if (mode === 'chat' && historyOpen) {
      h = Math.max(h, READY_BAR_H + HISTORY_PANEL_GAP + historyDropdownLayout.maxHeight + FLOATING_PADDING * 2)
    }

    if (showPromptPreview) {
      const cardH = promptPreviewCardHeight ?? PROMPT_PREVIEW_MAX_H
      h = Math.max(h, READY_BAR_H + PROMPT_PREVIEW_GAP + cardH + FLOATING_PADDING * 2)
    }

    const last = floatingSizeRef.current
    if (
      last
      && Math.round(last.width) === Math.round(w)
      && Math.round(last.height) === Math.round(h)
      && last.hasScreenshot === hasScreenshot
    ) {
      return
    }

    setVisionFloatingWithRetry({ width: w, height: h, hasScreenshot }, () => !cancelled)
      .then((applied) => {
        if (!applied || cancelled) return
        floatingSizeRef.current = { width: w, height: h, hasScreenshot }
      })
      .catch(err => console.error('[vision-floating] resize failed:', err))

    return () => {
      cancelled = true
    }
  }, [
    stage,
    answerLayout,
    barNoTransition,
    barRect,
    floatingRebased,
    historyDropdownLayout.maxHeight,
    historyOpen,
    mode,
    promptPreviewCardHeight,
    showPromptPreview,
    hasScreenshot,
  ])

  const beginFloatingPanelDrag = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return
    if (stageRef.current === 'select' || barRebaseHidden) return

    const target = e.target as HTMLElement | null
    if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return

    e.preventDefault()
    e.stopPropagation()

    if (isFloatingLayout) {
      if (!floatingRebased) return
      void api.startDragging().catch(err => console.error('[vision-floating] native drag failed:', err))
      return
    }

    panelDraggingRef.current = true
    setPanelDragActive(true)
    setNativeHitRegionActive(false)
    void api.visionSetHitRegion(null).catch(err => console.error('[vision-floating] clear hit region failed:', err))
    setVisionCursorPassthrough(false)

    setBarNoTransition(true)
    setBarFlyOffset({ x: 0, y: 0 })

    const startPoint = { x: e.clientX, y: e.clientY }
    const startRect = barRect

    const stopDrag = () => {
      if (!panelDraggingRef.current) return
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      panelDraggingRef.current = false
      setPanelDragActive(false)
      requestAnimationFrame(() => setBarNoTransition(false))
    }

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const nextX = startRect.x + ev.clientX - startPoint.x
      const nextY = startRect.y + ev.clientY - startPoint.y
      setBarRect(prev => ({ ...prev, x: Math.round(nextX), y: Math.round(nextY) }))
    }

    const onUp = () => stopDrag()

    window.addEventListener('mousemove', onMove, { capture: true, passive: false })
    window.addEventListener('mouseup', onUp, true)
  }, [
    barRebaseHidden,
    barRect,
    floatingRebased,
    isFloatingLayout,
    setVisionCursorPassthrough,
  ])

  useLayoutEffect(() => {
    window.dispatchEvent(new Event('screenpilot:vision-contract-change'))
  })

  return (
    <VisionLanguageContext.Provider value={lang}>
    <VisionCopyFeedbackContext.Provider value={copyFeedback}>
    <div
      className="fixed inset-0 select-none"
      data-screenpilot-vision-root="true"
      data-screenpilot-floating-layout={isFloatingLayout ? 'true' : undefined}
      data-screenpilot-floating-width={isFloatingLayout
        ? String(Math.max(1, Math.round(barRect.width + FLOATING_PADDING * 2)))
        : undefined}
      data-screenpilot-keyboard-selection={keyboardSelectionMode ?? undefined}
      aria-keyshortcuts="Alt+W Alt+R Alt+Enter"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      data-tauri-drag-region="false"
      style={{
        cursor: stage === 'select' ? 'crosshair' : undefined,
      }}
    >
      {captureWarning ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-3 z-[90] max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-amber-300/70 bg-amber-50/95 px-3 py-2 text-[12px] leading-5 text-amber-900 shadow-lg backdrop-blur dark:border-amber-700/70 dark:bg-amber-950/90 dark:text-amber-100"
        >
          {captureWarning}
        </div>
      ) : null}
      {streamListenerError ? (
        <div
          role="alert"
          data-screenpilot-stream-listener-error={streamListenerError}
          className="pointer-events-none absolute left-1/2 top-3 z-[92] max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-rose-300/70 bg-rose-50/95 px-3 py-2 text-[12px] leading-5 text-rose-700 shadow-lg backdrop-blur dark:border-rose-700/70 dark:bg-rose-950/90 dark:text-rose-200"
        >
          {t.visionStreamListenerFailed}
        </div>
      ) : null}
      {closeFailed ? (
        <div
          role="alert"
          data-screenpilot-close-error="true"
          className="pointer-events-none absolute left-1/2 top-3 z-[93] max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-rose-300/70 bg-rose-50/95 px-3 py-2 text-[12px] leading-5 text-rose-700 shadow-lg backdrop-blur dark:border-rose-700/70 dark:bg-rose-950/90 dark:text-rose-200"
        >
          {t.visionCloseFailed}
        </div>
      ) : null}
      {speechErrorAnnouncement ? (
        <span role="alert" className="sr-only">
          {speechErrorAnnouncement}
        </span>
      ) : null}
      {copyErrorAnnouncement ? (
        <div
          role="alert"
          data-screenpilot-copy-error="true"
          className="pointer-events-none absolute left-1/2 top-14 z-[91] max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-rose-300/70 bg-rose-50/95 px-3 py-2 text-[12px] leading-5 text-rose-700 shadow-lg backdrop-blur dark:border-rose-700/70 dark:bg-rose-950/90 dark:text-rose-200"
        >
          {copyErrorAnnouncement}
        </div>
      ) : null}
      {historyRejectedCount > 0 ? (
        <div className="sr-only" role="status" aria-live="polite">
          {lang === 'zh'
            ? `已忽略 ${historyRejectedCount} 条损坏的 Vision 历史记录。`
            : `${historyRejectedCount} corrupt Vision history item${historyRejectedCount === 1 ? '' : 's'} ignored.`}
        </div>
      ) : null}
      <p id="vision-selection-keyboard-help" className="sr-only">
        {lang === 'zh'
          ? '键盘截图：Alt+W 选择或循环窗口，Alt+左右方向键切换窗口，Alt+R 创建区域，Alt+方向键移动区域，Alt+Shift+方向键调整区域大小，Alt+Enter 截图，Escape 退出键盘选择。'
          : 'Keyboard capture: Alt+W selects or cycles windows, Alt+Left and Alt+Right switch windows, Alt+R creates a region, Alt+Arrow keys move it, Alt+Shift+Arrow keys resize it, Alt+Enter captures, and Escape exits keyboard selection.'}
      </p>
      <p id="vision-arrow-keyboard-help" className="sr-only">
        {lang === 'zh'
          ? '箭头标注：按 Enter 创建箭头，方向键调整终点，Shift+方向键平移箭头，再按 Enter 提交，Control+Z 撤销，Escape 退出。'
          : 'Arrow annotation: press Enter to create an arrow, use Arrow keys to adjust its endpoint, Shift+Arrow keys to move it, Enter again to commit, Control+Z to undo, and Escape to exit.'}
      </p>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-screenpilot-vision-announcement="true"
      >
        {a11yAnnouncement}
      </div>
      {stage === 'select' && (
        <div className="absolute inset-0 pointer-events-none">
          {!selectFocusRect ? (
            <div
              className="absolute inset-0 transition-opacity ease-out"
              style={{
                backgroundColor: SELECT_MASK_COLOR,
                transitionDuration: `${TRANSITION_MS}ms`,
              }}
            />
          ) : (
            <>
              <div
                className="absolute"
                style={{
                  left: 0,
                  top: 0,
                  width: viewport.w,
                  height: selectFocusRect.y,
                  backgroundColor: SELECT_MASK_COLOR,
                }}
              />
              <div
                className="absolute"
                style={{
                  left: 0,
                  top: selectFocusRect.y,
                  width: selectFocusRect.x,
                  height: selectFocusRect.height,
                  backgroundColor: SELECT_MASK_COLOR,
                }}
              />
              <div
                className="absolute"
                style={{
                  left: selectFocusRect.x + selectFocusRect.width,
                  top: selectFocusRect.y,
                  width: viewport.w - (selectFocusRect.x + selectFocusRect.width),
                  height: selectFocusRect.height,
                  backgroundColor: SELECT_MASK_COLOR,
                }}
              />
              <div
                className="absolute"
                style={{
                  left: 0,
                  top: selectFocusRect.y + selectFocusRect.height,
                  width: viewport.w,
                  height: viewport.h - (selectFocusRect.y + selectFocusRect.height),
                  backgroundColor: SELECT_MASK_COLOR,
                }}
              />
            </>
          )}
        </div>
      )}

      {capturedFrame && stage !== 'select' && keepFullscreen && !floatingRebased && !barRebaseHidden && (
        <>
          <ShareXSelectionFrame rect={capturedFrame} />
          <ShareXInfoLabel
            rect={capturedFrame}
            text={`X: ${Math.round(winOrigin.x + capturedFrame.x)}, Y: ${Math.round(winOrigin.y + capturedFrame.y)}, ${Math.round(capturedFrame.width)} x ${Math.round(capturedFrame.height)}`}
            viewport={viewport}
          />
        </>
      )}

      {capturedFrame && stage === 'ready' && keepFullscreen && !floatingRebased && !barRebaseHidden && !drawMode && arrows.length > 0 && (
        <svg
          className="absolute pointer-events-none"
          style={{
            left: capturedFrame.x,
            top: capturedFrame.y,
            width: capturedFrame.width,
            height: capturedFrame.height,
            overflow: 'visible',
            zIndex: 9,
          }}
          width={capturedFrame.width}
          height={capturedFrame.height}
        >
          {arrows.map((a, i) => (
            <ArrowSvg key={i} arrow={a} />
          ))}
        </svg>
      )}

      {capturedFrame && stage === 'ready' && keepFullscreen && !floatingRebased && !barRebaseHidden && drawMode && (
        <div
          ref={drawSurfaceRef}
          id="vision-arrow-surface"
          tabIndex={0}
          role="group"
          aria-label={lang === 'zh' ? '截图箭头标注画布' : 'Screenshot arrow annotation canvas'}
          aria-describedby="vision-arrow-keyboard-help"
          data-screenpilot-arrow-surface="true"
          className="absolute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kv-accent)]"
          style={{
            left: capturedFrame.x,
            top: capturedFrame.y,
            width: capturedFrame.width,
            height: capturedFrame.height,
            cursor: 'crosshair',
            zIndex: 11,
            touchAction: 'none',
          }}
          onPointerDown={(e) => {
            e.stopPropagation()
            ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
            const rect = e.currentTarget.getBoundingClientRect()
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            setDraftArrow({ x1: x, y1: y, x2: x, y2: y })
          }}
          onPointerMove={(e) => {
            if (!draftArrow) return
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
            const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
            setDraftArrow(d => (d ? { ...d, x2: x, y2: y } : d))
          }}
          onPointerUp={(e) => {
            e.stopPropagation()
            if (!draftArrow) return
            const dx = draftArrow.x2 - draftArrow.x1
            const dy = draftArrow.y2 - draftArrow.y1
            if (Math.hypot(dx, dy) >= ARROW_MIN_DRAG_PX) {
              setArrows(prev => [...prev, draftArrow])
              setA11yAnnouncement(lang === 'zh' ? '箭头已添加。' : 'Arrow added.')
            }
            setDraftArrow(null)
            ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
          }}
          onPointerCancel={(e) => {
            e.stopPropagation()
            setDraftArrow(null)
            try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId) } catch { void 0 }
          }}
          onKeyDown={(e) => {
            const isArrowKey = e.key === 'ArrowLeft'
              || e.key === 'ArrowRight'
              || e.key === 'ArrowUp'
              || e.key === 'ArrowDown'
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              if (draftArrow === null) {
                setDraftArrow(defaultKeyboardArrow({ w: capturedFrame.width, h: capturedFrame.height }))
                setA11yAnnouncement(lang === 'zh'
                  ? '已创建默认箭头。使用方向键调整终点，Shift+方向键平移，再按 Enter 提交。'
                  : 'Default arrow created. Use Arrow keys to adjust its endpoint, Shift+Arrow keys to move it, then press Enter to commit.')
              } else {
                const dx = draftArrow.x2 - draftArrow.x1
                const dy = draftArrow.y2 - draftArrow.y1
                if (Math.hypot(dx, dy) >= ARROW_MIN_DRAG_PX) {
                  setArrows(prev => [...prev, draftArrow])
                  setA11yAnnouncement(lang === 'zh' ? '箭头已添加。' : 'Arrow added.')
                }
                setDraftArrow(null)
              }
              return
            }
            if (!isArrowKey) return
            e.preventDefault()
            e.stopPropagation()
            const current = draftArrow ?? defaultKeyboardArrow({ w: capturedFrame.width, h: capturedFrame.height })
            const next = adjustKeyboardArrow(
              current,
              { w: capturedFrame.width, h: capturedFrame.height },
              e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
              e.shiftKey,
            )
            setDraftArrow(next)
            setA11yAnnouncement(lang === 'zh'
              ? `箭头起点 ${Math.round(next.x1)}, ${Math.round(next.y1)}；终点 ${Math.round(next.x2)}, ${Math.round(next.y2)}。`
              : `Arrow start ${Math.round(next.x1)}, ${Math.round(next.y1)}; endpoint ${Math.round(next.x2)}, ${Math.round(next.y2)}.`)
          }}
        >
          <svg
            width={capturedFrame.width}
            height={capturedFrame.height}
            className="absolute inset-0 pointer-events-none"
            style={{ overflow: 'visible' }}
          >
            {arrows.map((a, i) => (
              <ArrowSvg key={i} arrow={a} />
            ))}
            {draftArrow && <ArrowSvg arrow={draftArrow} />}
          </svg>
        </div>
      )}

      {stage === 'select' && (
        <>
          {selectFrameRect && (
            <>
              <ShareXSelectionFrame rect={selectFrameRect} />
              <ShareXInfoLabel rect={selectFrameRect} text={selectFrameText} viewport={viewport} />
            </>
          )}
        </>
      )}

      {showBar && (
          <div
            ref={barPanelRef}
          data-screenpilot-prompt-panel="true"
          data-screenpilot-ready-prompt-panel={stage !== 'select' || hasScreenshot ? 'true' : 'false'}
            data-screenpilot-captured-prompt-panel={hasScreenshot ? 'true' : 'false'}
            data-screenpilot-answer-visible={stage === 'answering' ? 'true' : 'false'}
          className="absolute ease-out"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseMove={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            left: barRect.x,
            top: barRect.y,
            width: barRect.width,
            transitionProperty: barNoTransition ? 'none' : 'transform, opacity',
            transitionDuration: barNoTransition ? '0ms' : `${hideSelectBar ? SELECT_BAR_COLLAPSE_MS : TRANSITION_MS}ms`,
            transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            transform: barMotionActive
              ? `translate3d(${barFlyOffset.x}px, ${barFlyOffset.y}px, 0) scale(${barIntro && !hideSelectBar ? 1 : 0.92})`
              : undefined,
            willChange: barMotionActive ? 'transform, opacity' : undefined,
            opacity: barIntro && !hideSelectBar ? 1 : 0,
            visibility: barRebaseHidden ? 'hidden' : undefined,
            pointerEvents: hideSelectBar || barRebaseHidden ? 'none' : undefined,
          }}
        >
          <div
            className={`flex items-center gap-3 pl-4 pr-2 py-2 rounded-[18px] bg-white dark:bg-neutral-900 ring-1 ring-[color:var(--kv-panel-edge)] ${stage === 'select' ? 'cursor-default' : 'cursor-move'} ${jellyActive && isFloatingLayout ? 'vision-jelly-pop' : ''}`}
            data-screenpilot-prompt-bar="true"
            data-screenpilot-window-frame="true"
            data-screenpilot-vision-image={hasScreenshot ? 'true' : 'false'}
            onMouseDown={beginFloatingPanelDrag}
            onAnimationEnd={handleJellyAnimationEnd}
            data-tauri-drag-region="false"
          >
            <div className="shrink-0 flex items-center gap-2">
              {showThumb ? (
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl overflow-hidden ring-1 ring-black/[0.06] dark:ring-white/[0.06] bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center shadow-sm">
                    {imagePreview ? (
                      <img
                        src={imagePreview}
                        alt={t.visionScreenshotPreview}
                        data-screenpilot-screenshot-preview="true"
                        className="w-full h-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <ImageIcon size={14} className="text-neutral-400" />
                    )}
                  </div>
                  {appLabel && (
                    <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 max-w-[100px] truncate">{appLabel}</span>
                  )}
                </div>
              ) : (
                <img
                  src="/emojione--leaf-fluttering-in-wind.svg"
                  alt=""
                  className="w-7 h-7 object-contain"
                  draggable={false}
                />
              )}
              {selectionLineCount > 0 && (
                <span
                  title={lang === 'zh' ? `已选中 ${selectionLineCount} 行` : `${selectionLineCount} lines selected`}
                  className="select-none px-1.5 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-[11px] font-medium tabular-nums text-neutral-600 dark:text-neutral-400 ring-1 ring-black/[0.04] dark:ring-white/[0.06]"
                >
                  {selectionLineCount}
                </span>
              )}
              {stage === 'ready' && keepFullscreen && !floatingRebased && (
                <button
                  type="button"
                  onClick={() => setDrawMode(m => !m)}
                  disabled={!imagePreview}
                  aria-pressed={drawMode}
                  aria-controls="vision-arrow-surface"
                  aria-describedby="vision-arrow-keyboard-help"
                  aria-label={imagePreview
                    ? (drawMode ? t.visionArrowToggleOff : t.visionArrowToggle)
                    : t.visionArrowDisabledHint}
                  data-screenpilot-arrow-toggle="true"
                  title={imagePreview
                    ? (drawMode ? t.visionArrowToggleOff : t.visionArrowToggle)
                    : t.visionArrowDisabledHint}
                  className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all active:scale-95 ${
                    drawMode
                      ? 'bg-[var(--kv-accent)] text-white shadow-[0_1px_3px_rgba(15,23,42,0.25)]'
                      : 'text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]'
                  } ${!imagePreview ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <MousePointer2 size={15} strokeWidth={1.75} />
                </button>
              )}
            </div>
            <input
              ref={inputRef}
              data-screenpilot-vision-prompt="true"
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return
                // IME 合成中（中/日/韩选词按回车）跳过 — isComposing 官方信号 + keyCode 229 兜底
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                void handleSend()
              }}
              readOnly={streaming || promptOptimizing}
              aria-disabled={streaming || promptOptimizing}
              aria-describedby={stage === 'select' ? 'vision-selection-keyboard-help' : undefined}
              placeholder={t.visionAskPlaceholder}
              className={`flex-1 bg-transparent text-[16px] text-neutral-900 dark:text-white placeholder-neutral-500 dark:placeholder-neutral-400 focus:outline-none cursor-text ${streaming || promptOptimizing ? 'opacity-60' : ''}`}
            />
            <div ref={historyPanelRef} className="relative shrink-0">
              <button
                ref={historyTriggerRef}
                type="button"
                onClick={() => setHistoryOpen(o => !o)}
                aria-label={t.visionHistory}
                aria-expanded={historyOpen}
                aria-haspopup="dialog"
                aria-controls="vision-history-dialog"
                data-screenpilot-vision-history-trigger="true"
                className="flex items-center gap-1 h-9 px-2.5 rounded-lg text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] active:bg-black/[0.08] dark:active:bg-white/[0.1] transition-colors cursor-pointer"
                title={t.visionHistory}
              >
                <HistoryIcon size={15} strokeWidth={1.75} />
                {history.length > 0 && (
                  <span className="text-[11px] font-medium tabular-nums text-neutral-500 dark:text-neutral-400">{history.length}</span>
                )}
                <ChevronDown size={13} strokeWidth={2} className={`transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
              </button>
              {historyOpen && (
                <div
                  ref={historyDropdownRef}
                  id="vision-history-dialog"
                  role="dialog"
                  aria-label={t.visionHistory}
                  tabIndex={-1}
                  data-screenpilot-vision-history-dialog="true"
                  onBlur={(event) => {
                    const nextTarget = event.relatedTarget
                    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
                    setHistoryOpen(false)
                  }}
                  className={`absolute right-0 ${historyDropdownLayout.openBelow ? 'top-full mt-2' : 'bottom-full mb-2'} w-[240px] rounded-xl bg-white dark:bg-neutral-900 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.35)] dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden z-50`}
                >
                  <div
                    className="overflow-y-auto custom-scrollbar py-1"
                    style={{ maxHeight: historyDropdownLayout.maxHeight }}
                  >
                    {history.length === 0 ? (
                      <div className="px-2.5 py-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                        {t.visionNoHistory}
                      </div>
                    ) : (
                      history.map(item => {
                        // 首条 user 消息可能含 [已选文本]\n...\n\n[用户问题]\n... 的拼接形式（chat 启动注入），
                        // 历史预览只显示问题原文，剥掉 marker 段
                        const firstUserRaw = item.messages.find(m => m.role === 'user')?.content ?? ''
                        const zhMarker = '[用户问题]\n'
                        const enMarker = '[Question]\n'
                        const zhIdx = firstUserRaw.indexOf(zhMarker)
                        const enIdx = firstUserRaw.indexOf(enMarker)
                        const firstUserQ = zhIdx >= 0
                          ? firstUserRaw.slice(zhIdx + zhMarker.length)
                          : enIdx >= 0
                            ? firstUserRaw.slice(enIdx + enMarker.length)
                            : firstUserRaw
                        const turns = item.messages.filter(m => m.role === 'user').length
                        return (
                          <button
                            key={`${item.id}-${item.timestamp}`}
                            type="button"
                            onClick={() => void restoreHistory(item)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                          >
                            <div className="shrink-0 w-6 h-6 rounded overflow-hidden bg-neutral-100 dark:bg-neutral-800 ring-1 ring-black/[0.05] dark:ring-white/[0.06] flex items-center justify-center">
                              {item.imagePreview ? (
                                <img src={item.imagePreview} alt="" className="w-full h-full object-cover" />
                              ) : item.textOnly ? (
                                // 纯文字会话本来就没有截图，用对话图标区分，
                                // 避免和"有图但缩略图生成失败"看起来一样
                                <MessageSquare size={10} className="text-neutral-400" />
                              ) : (
                                <ImageIcon size={10} className="text-neutral-400" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-[11.5px] text-neutral-800 dark:text-neutral-200 truncate leading-tight">
                                {firstUserQ}
                              </div>
                              <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5 truncate leading-tight">
                                {item.appLabel ? `${item.appLabel} · ` : ''}{turns > 1 ? `${turns} ${lang === 'zh' ? '轮' : 'turns'} · ` : ''}{relTime(item.timestamp)}
                              </div>
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sendDisabled}
              aria-label={t.visionHintSend}
              data-screenpilot-vision-send="true"
              className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150 active:scale-95 ${
                !sendDisabled
                  ? 'bg-[#D97757] hover:bg-[#C56646] hover:scale-105 cursor-pointer shadow-[0_1px_3px_rgba(15,23,42,0.2)]'
                  : 'bg-neutral-100 dark:bg-neutral-800 cursor-not-allowed'
              }`}
            >
              <ArrowUp
                size={18}
                strokeWidth={2.25}
                className={!sendDisabled ? 'text-white' : 'text-neutral-300 dark:text-neutral-600'}
              />
            </button>
            <button
              type="button"
              // 优化中再点一次 = 取消。以前这里是 disabled，想中断只能 esc 关掉整个窗口。
              onClick={() => void handleOptimizeVisionPrompt()}
              disabled={!canOptimizePrompt && !promptOptimizing}
              title={promptOptimizing ? t.visionStop : t.promptOptimizerOptimize}
              aria-label={promptOptimizing ? t.visionStop : t.promptOptimizerOptimize}
              // 发送键（橙）已经是主操作，这里同样填满高饱和蓝会两个主色打架。
              // 降成淡色底 + 强调色图标，主次一眼可辨。
              className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150 active:scale-95 ${
                canOptimizePrompt || promptOptimizing
                  ? 'bg-[var(--kv-accent-soft)] text-[var(--kv-accent-text)] hover:brightness-95 hover:scale-105 cursor-pointer'
                  : 'bg-neutral-100 dark:bg-neutral-800 cursor-not-allowed text-neutral-300 dark:text-neutral-600'
              }`}
            >
              {promptOptimizing
                ? <Loader2 size={18} strokeWidth={2.15} className="animate-spin" />
                : <Sparkles size={18} strokeWidth={2.15} />}
            </button>
            <button
              type="button"
              onClick={() => void closeLikeEscape()}
              title={t.shotClose}
              aria-label={t.shotClose}
              className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] active:scale-95 transition-all cursor-pointer"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>

          {stage === 'select' && (
            <div className="mt-2 flex justify-center gap-3 text-[11px] text-white/70 pointer-events-none">
              <span>↵ {t.visionHintSend}</span>
              <span>·</span>
              <span>esc {t.visionHintEsc}</span>
            </div>
          )}

          {showPromptPreview && (
            <div
              ref={promptPreviewCardRef}
              data-screenpilot-vision-prompt-preview="true"
              className="animate-in fade-in slide-in-from-top-1 duration-150 absolute left-0 right-0 z-40 rounded-2xl overflow-hidden window-frosted select-text"
              // maxHeight 是硬约束不是装饰：见 PROMPT_PREVIEW_MAX_H 的说明
              style={promptPreviewPlaceAbove
                ? { bottom: `calc(100% + ${PROMPT_PREVIEW_GAP}px)`, maxHeight: PROMPT_PREVIEW_MAX_H }
                : { top: `calc(100% + ${PROMPT_PREVIEW_GAP}px)`, maxHeight: PROMPT_PREVIEW_MAX_H }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div data-screenpilot-prompt-preview-source="true" className="px-3.5 pt-3 pb-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-neutral-400 dark:text-neutral-500">
                  {t.shotOriginal}
                </div>
                <div className="line-clamp-2 text-[12.5px] leading-[1.5] text-neutral-500 dark:text-neutral-400">
                  {promptPreviewSource}
                </div>
              </div>

              <div data-screenpilot-prompt-preview-body="true" className="border-t border-black/[0.05] px-3.5 pt-2.5 pb-3 dark:border-white/[0.06]">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--kv-accent-text)]">
                  {t.visionPromptOptimized}
                </div>

                {promptPreviewStatus === 'loading' ? (
                  <div className="space-y-2 py-1" role="status" aria-live="polite">
                    <span className="sr-only">{lang === 'zh' ? '正在优化提示词。' : 'Optimizing prompt.'}</span>
                    <div className="h-3 rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite] dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800" />
                    <div className="h-3 w-[82%] rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite] dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800" />
                    <div className="h-3 w-[64%] rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite] dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800" />
                  </div>
                ) : promptPreviewStatus === 'error' ? (
                  <div role="alert" className="text-[12.5px] leading-[1.5] text-rose-600 dark:text-rose-400">
                    {t.visionPromptFailed}
                  </div>
                ) : (
                  <textarea
                    ref={promptPreviewEditorRef}
                    data-screenpilot-prompt-preview-editor="true"
                    value={promptPreviewText}
                    onChange={(e) => setPromptPreviewText(e.target.value)}
                    spellCheck={false}
                    // 在这里改完直接「采纳」，采纳的就是改过的版本
                    // （acceptOptimizedPrompt 读的就是 promptPreviewText）
                    className="block w-full resize-none overflow-y-auto custom-scrollbar bg-transparent text-[13px] leading-[1.6] text-neutral-800 outline-none dark:text-neutral-100"
                    style={{ maxHeight: PROMPT_PREVIEW_MAX_H - PROMPT_PREVIEW_CHROME_H }}
                  />
                )}

                <div data-screenpilot-prompt-preview-actions="true" className="mt-2.5 flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={discardOptimizedPrompt}
                    className="kv-btn kv-btn-sm kv-btn-ghost"
                  >
                    {t.visionPromptDiscard}
                  </button>
                  {promptPreviewStatus === 'error' ? (
                    <button
                      type="button"
                      onClick={() => void handleOptimizeVisionPrompt()}
                      className="kv-btn kv-btn-sm kv-btn-primary"
                    >
                      {t.visionPromptRetry}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={acceptOptimizedPrompt}
                      disabled={promptPreviewStatus !== 'ready' || !promptPreviewText.trim()}
                      className="kv-btn kv-btn-sm kv-btn-primary"
                    >
                      <Check size={11} strokeWidth={2.5} />
                      {t.visionPromptAccept}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div
            ref={answerPanelRef}
            data-screenpilot-answer-panel="true"
            aria-busy={stage === 'answering' && streaming}
            className="absolute left-0 right-0 rounded-2xl overflow-hidden window-frosted transition-all ease-out select-text"
            style={{
              top: answerLayout.placeAbove ? undefined : 'calc(100% + 8px)',
              bottom: answerLayout.placeAbove ? 'calc(100% + 8px)' : undefined,
              height: stage === 'answering' ? answerLayout.height : 0,
              opacity: stage === 'answering' ? 1 : 0,
              transitionDuration: `${TRANSITION_MS}ms`,
              pointerEvents: stage === 'answering' ? 'auto' : 'none',
            }}
          >
            {stage === 'answering' && (() => {
              const ordered = messageOrder === 'desc' ? messages.slice().reverse() : messages
              const lastChronoIdx = messages.length - 1
              const lastMsg = messages[lastChronoIdx]
              const showActions = lastMsg && lastMsg.role === 'assistant' && !!lastMsg.content
              const Actions = (
                <div className="flex items-center gap-1" data-screenpilot-answer-actions="true">
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    data-screenpilot-copy-target="answer"
                    data-screenpilot-copy-state={copiedTarget === 'answer' ? 'copied' : 'idle'}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  >
                    {copiedTarget === 'answer' ? <Check size={11} /> : <Copy size={11} />}
                    <span>{copiedTarget === 'answer' ? t.visionCopied : t.visionCopy}</span>
                  </button>
                  {streaming && (
                    <button
                      onClick={() => void handleStop()}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-neutral-500 hover:text-red-500 dark:text-neutral-400 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    >
                      <Square size={10} strokeWidth={2.5} fill="currentColor" />
                      <span>{t.visionStop}</span>
                    </button>
                  )}
                </div>
              )
              return (
              <div
                ref={chatScrollRef}
                role="log"
                aria-live="polite"
                aria-relevant="additions text"
                aria-busy={streaming}
                data-screenpilot-answer-scroll="true"
                className="h-full overflow-y-auto custom-scrollbar px-3.5 py-3"
                onScroll={updateChatAutoFollow}
              >
                {messageOrder === 'desc' && showActions && Actions}
                {ordered.map((m, displayIdx) => {
                  const origIdx = messageOrder === 'desc' ? messages.length - 1 - displayIdx : displayIdx
                  const isUser = m.role === 'user'
                  const isLast = origIdx === lastChronoIdx
                  return (
                    <div key={origIdx} className={`mb-3 ${isUser ? 'flex justify-end' : ''}`}>
                      {isUser ? (
                        <div className="px-3 py-2 rounded-2xl bg-[#D97757]/15 dark:bg-[#D97757]/20 text-[13.5px] text-neutral-800 dark:text-neutral-100 max-w-[88%] whitespace-pre-wrap break-words">
                          {m.content}
                        </div>
                      ) : (
                        <div className="prose prose-sm dark:prose-invert max-w-none text-[13.5px] leading-7 text-neutral-800 dark:text-neutral-200">
                          {m.reasoning && (
                            <ThinkingBlock
                              reasoning={m.reasoning}
                              active={isLast && streaming && !m.content}
                              thinkingLabel={t.visionThinking}
                              thoughtLabel={t.visionThought}
                            />
                          )}
                          {m.content ? (
                            <StreamingMarkdownText text={m.content} active={isLast && streaming} />
                          ) : isLast && streaming && !m.reasoning ? (
                            <div role="status" className="not-prose flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
                              <Loader2 className="animate-spin" size={14} />
                              <span className="text-[12px]">{formatVisionAsking(t.visionAsking, activeVisionModel)}</span>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })}
                {messageOrder === 'asc' && showActions && Actions}
              </div>
              )
            })()}
          </div>
        </div>
      )}

      {showTranslateCard && (
        <div
          ref={translateCardRef}
          data-screenpilot-translation-card="true"
          data-screenpilot-native-flight-active={barNoTransition || (jellyActive && isFloatingLayout) ? 'true' : 'false'}
          aria-busy={stage === 'translating' || methodSwitching || translateRetranslating}
          className={`absolute ease-out rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_10px_28px_-20px_rgba(0,0,0,0.28)] ring-1 ring-black/[0.04] dark:ring-white/[0.06] overflow-hidden select-text ${jellyActive && isFloatingLayout ? 'vision-ocr-jelly-pop' : ''}`}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseMove={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            left: barRect.x,
            top: barRect.y,
            width: barRect.width,
            maxHeight: isFloatingLayout || !keepFullscreen
              ? READY_BAR_H + 8 + stableAnswerHeight
              : Math.min(viewport.h - 32, READY_BAR_H + 8 + stableAnswerHeight),
            transitionProperty: barNoTransition ? 'none' : 'transform, opacity',
            transitionDuration: barNoTransition ? '0ms' : `${TRANSITION_MS}ms`,
            transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            transform: barMotionActive
              ? `translate3d(${barFlyOffset.x}px, ${barFlyOffset.y}px, 0) scale(${barIntro ? 1 : 0.92})`
              : undefined,
            willChange: barMotionActive ? 'transform, opacity' : undefined,
            opacity: barIntro ? 1 : 0,
            visibility: barRebaseHidden ? 'hidden' : undefined,
          }}
          onAnimationEnd={handleJellyAnimationEnd}
          data-tauri-drag-region="false"
        >
          <div
            data-screenpilot-translation-header="true"
            className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-black/[0.05] dark:border-white/[0.06] cursor-move"
            onMouseDown={beginFloatingPanelDrag}
            data-tauri-drag-region="false"
          >
            <div className="shrink-0 w-8 h-8 rounded-lg overflow-hidden ring-1 ring-black/[0.06] dark:ring-white/[0.06] bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt={t.visionScreenshotPreview}
                  data-screenpilot-screenshot-preview="true"
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <ImageIcon size={12} className="text-neutral-400" />
              )}
            </div>
            <span className="text-[12.5px] font-medium text-neutral-700 dark:text-neutral-300 truncate flex-1">
              {appLabel || t.shotTitle}
            </span>
            {(() => {
              const elapsedMs = stage === 'translating' && translateStartRef.current
                ? translateNow - translateStartRef.current
                : translateDurationMs
              const seconds = elapsedMs !== null ? Math.max(1, Math.round(elapsedMs / 1000)) : null
              const tokens = formatTokens(estimateTokens(translateOriginal + translateText))
              return (
                <span className="shrink-0 flex items-center gap-1 text-[10.5px] text-neutral-400 dark:text-neutral-500 tabular-nums">
                  {seconds !== null && <span>{seconds}s</span>}
                  {translateText && <span>· ~{tokens} tokens</span>}
                </span>
              )
            })()}
            <button
              type="button"
              onClick={() => void closeLikeEscape()}
              title={t.shotClose}
              aria-label={t.shotClose}
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>

          <div
            data-screenpilot-translation-body="true"
            className="px-3.5 py-3 overflow-y-auto custom-scrollbar"
            style={{
              maxHeight: isFloatingLayout || !keepFullscreen
                ? stableAnswerHeight
                : Math.min(viewport.h - 110, stableAnswerHeight)
            }}>
            <>
              {showTranslateOriginal && (
                <div data-screenpilot-ocr-container="true">
                  <div data-screenpilot-original-heading="true" className="mb-1.5 flex items-center gap-1.5">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
                      {t.shotOriginal}
                    </span>
                    {ocrMethodSwitching && (
                      <span role="status" aria-live="polite" className="shrink-0 inline-flex">
                        <Loader2 size={10} className="animate-spin text-neutral-400 dark:text-neutral-500" />
                        <span className="sr-only">{lang === 'zh' ? '正在切换 OCR 方法。' : 'Switching OCR method.'}</span>
                      </span>
                    )}
                    {translateOriginal && (
                      <>
                        <button
                          type="button"
                          onClick={() => void copyTextWithFeedback(translateOriginal, 'original')}
                          data-screenpilot-copy-target="original"
                          data-screenpilot-copy-state={copiedTarget === 'original' ? 'copied' : 'idle'}
                          title={copiedTarget === 'original' ? t.visionCopied : t.visionCopy}
                          aria-label={copiedTarget === 'original' ? t.visionCopied : t.visionCopy}
                          className="shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                        >
                          {copiedTarget === 'original' ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        {!readonlyAiOcrOriginal && (
                          <button
                            type="button"
                            onClick={() => void speakText(translateOriginal, 'original')}
                            title={visionSpeechControlLabel('original', speakingTarget, speechErrorTarget, {
                              speak: t.visionSpeak,
                              stop: t.visionStop,
                              retry: t.visionSpeechRetry,
                            })}
                            aria-label={visionSpeechControlLabel('original', speakingTarget, speechErrorTarget, {
                              speak: t.visionSpeak,
                              stop: t.visionStop,
                              retry: t.visionSpeechRetry,
                            })}
                            className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors ${
                              speechErrorTarget === 'original'
                                ? 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300'
                                : speakingTarget === 'original'
                                ? 'text-neutral-700 dark:text-neutral-100'
                                : 'text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-100'
                            }`}
                          >
                            {speechLoadingTarget === 'original'
                              ? <Loader2 size={12} className="animate-spin" />
                              : <Play size={12} fill="currentColor" strokeWidth={speechErrorTarget === 'original' ? 2 : 0} />}
                          </button>
                        )}
                      </>
                    )}
                    <span data-screenpilot-source-language-slot="true" className="contents" />
                    <select
                      data-screenpilot-ocr-method="true"
                      value={translateOcrMethod}
                      disabled={methodSwitching}
                      onChange={(e) => void handleOcrMethodSelect(e.target.value)}
                      title={t.screenshotOcrMethod}
                      aria-label={t.screenshotOcrMethod}
                      className={methodSelectClass}
                    >
                      {ocrMethodOptions.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  {translateOriginalError ? (
                    <div role="alert" className="text-[12.5px] text-red-500 leading-6 whitespace-pre-wrap break-words">
                      {translateOriginalError}
                    </div>
                  ) : translateOriginal || translateOriginalEditedRef.current ? readonlyAiOcrOriginal ? (
                    <ReadonlyOcrMarkdownText text={translateOriginal} />
                  ) : (
                    <EditableOcrText
                      value={translateOriginal}
                      onChange={handleTranslateOriginalChange}
                    />
                  ) : (
                    <div className="space-y-2" role="status" aria-live="polite">
                      <span className="sr-only">{lang === 'zh' ? '正在识别截图文字。' : 'Recognizing text in the screenshot.'}</span>
                      <div className="h-3.5 rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite]" />
                      <div className="h-3.5 rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite] w-[82%]" />
                    </div>
                  )}
                </div>
              )}

              {showTranslateOriginal && (
                <div data-screenpilot-translation-divider="true" className="border-t border-black/[0.05] dark:border-white/[0.06] -mx-3.5 my-3" />
              )}

              <div data-screenpilot-translated-heading="true" className="mb-1.5 flex items-center gap-1.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
                  {t.shotTranslated}
                </span>
                {(translateRetranslating || translationMethodSwitching) && (
                  <span role="status" aria-live="polite" className="flex items-center gap-1 text-[10.5px] text-neutral-400 dark:text-neutral-500">
                    <Loader2 size={10} className="animate-spin" />
                    {t.shotTranslating}
                  </span>
                )}
                {translateText && (
                  <>
                    <button
                      type="button"
                      onClick={() => void copyTextWithFeedback(translateText, 'translated')}
                      data-screenpilot-copy-target="translated"
                      data-screenpilot-copy-state={copiedTarget === 'translated' ? 'copied' : 'idle'}
                      title={copiedTarget === 'translated' ? t.visionCopied : t.visionCopy}
                      aria-label={copiedTarget === 'translated' ? t.visionCopied : t.visionCopy}
                      className="shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                    >
                      {copiedTarget === 'translated' ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void speakText(translateText, 'translated')}
                      title={visionSpeechControlLabel('translated', speakingTarget, speechErrorTarget, {
                        speak: t.visionSpeak,
                        stop: t.visionStop,
                        retry: t.visionSpeechRetry,
                      })}
                      aria-label={visionSpeechControlLabel('translated', speakingTarget, speechErrorTarget, {
                        speak: t.visionSpeak,
                        stop: t.visionStop,
                        retry: t.visionSpeechRetry,
                      })}
                      className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors ${
                        speechErrorTarget === 'translated'
                          ? 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300'
                          : speakingTarget === 'translated'
                          ? 'text-neutral-700 dark:text-neutral-100'
                          : 'text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-100'
                      }`}
                    >
                      {speechLoadingTarget === 'translated'
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Play size={12} fill="currentColor" strokeWidth={speechErrorTarget === 'translated' ? 2 : 0} />}
                    </button>
                  </>
                )}
                <span data-screenpilot-target-language-slot="true" className="contents" />
                <select
                  data-screenpilot-translation-method="true"
                  value={translateMethod}
                  disabled={methodSwitching}
                  onChange={(e) => void handleTranslationMethodSelect(e.target.value)}
                  title={t.screenshotTranslationMethod}
                  aria-label={t.screenshotTranslationMethod}
                  className={methodSelectClass}
                >
                  {translationMethodOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div data-screenpilot-target-result-slot="true" data-screenpilot-target-result="true" />
              {translateText && (
                readonlyAiOcrOriginal ? (
                  <div data-screenpilot-native-translation-result="true">
                    <ReadableMarkdownText text={translateText} />
                  </div>
                ) : (
                  <div data-screenpilot-native-translation-result="true" className="vision-readable-text text-[13px] leading-[1.48] text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words select-text">
                    {translateText}
                  </div>
                )
              )}
              {translateError && (
                <div role="alert" className="mt-2 text-[12.5px] text-red-500 leading-6 whitespace-pre-wrap break-words">
                  {t.visionError}: {translateError}
                </div>
              )}
              {!translateText && !translateError && !translateOriginalError && (!translateOriginalEditedRef.current || translateRetranslating) && (
                <div className="space-y-2" role="status" aria-live="polite">
                  <span className="sr-only">{t.shotTranslating}</span>
                  <div className="h-3.5 rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite]" />
                  <div className="h-3.5 rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite] w-[88%]" />
                  <div className="h-3.5 rounded bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 dark:from-neutral-800 dark:via-neutral-700 dark:to-neutral-800 bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite] w-[72%]" />
                </div>
              )}
            </>
          </div>
        </div>
      )}
    </div>
    </VisionCopyFeedbackContext.Provider>
    </VisionLanguageContext.Provider>
  )
}
