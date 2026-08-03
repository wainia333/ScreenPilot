import { Check, Clipboard, Clock3, Languages, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDesktop } from '../../desktop/use-desktop'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'
import { translationMethodOptions } from '../settings/translation-methods'
import type { AppSettings, TranslationLanguage, TranslationMethod } from '../settings/types'
import { isValidModelSelection, normalizeAiAvailability } from '../settings/sanitize'
import { DEFAULT_SETTINGS } from '../settings/defaults'
import type { TranslationSettingsPatch } from '../../desktop/contract'
import { useSplitRatio } from '../../shared/hooks/use-split-ratio'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'

type TargetLanguage = TranslationLanguage

type TranslationHistory = {
  id: string
  input: string
  output: string
  method: TranslationMethod
  updatedAt: number
}

const historyKey = 'screenpilot:translator-history'
const goldenSectionRatio = (3 - Math.sqrt(5)) / 2
const targetLanguageOptions: { value: TargetLanguage; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]
const sourceLanguageOptions: { value: TranslationLanguage; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

function translationRequestKey(input: string, settings: AppSettings): string {
  return JSON.stringify([
    input,
    settings.translation.method,
    settings.translation.sourceLanguage,
    settings.translation.targetLanguage,
  ])
}

function validHistory(value: unknown): value is TranslationHistory {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<TranslationHistory>
  return (
    typeof item.id === 'string' &&
    typeof item.input === 'string' &&
    typeof item.output === 'string' &&
    typeof item.method === 'string' &&
    typeof item.updatedAt === 'number'
  )
}

export function TranslatorPage() {
  const desktop = useDesktop()
  const beginWindowDrag = useWindowDrag()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [arrivalCycle, setArrivalCycle] = useState(0)
  const [history, setHistory] = useState(() => loadHistory(localStorage, historyKey, validHistory))
  const generation = useRef(0)
  const roundId = useRef<string>(crypto.randomUUID())
  const composing = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const immediateRequest = useRef<string | null>(null)
  const { ratio, beginResize } = useSplitRatio(
    'screenpilot:translator-ocr-golden-split',
    goldenSectionRatio,
  )
  useEffect(() => {
    const lifecycle = { active: true }
    let prepareUnlisten: (() => void) | undefined
    let selectionUnlisten: (() => void) | undefined
    void desktop.onTranslatorPrepare(() => {
      if (!lifecycle.active) return
      generation.current += 1
      roundId.current = crypto.randomUUID()
      setInput('')
      setOutput('')
      setError(null)
      setLoading(false)
      setHistoryOpen(false)
      setCopied(false)
      setArrivalCycle((value) => value + 1)
    }).then((unlisten) => {
      if (lifecycle.active) prepareUnlisten = unlisten
      else unlisten()
    })
    void desktop.onTranslatorSelection((selected) => {
      if (!lifecycle.active) return
      setInput(selected)
      queueMicrotask(() => inputRef.current?.focus())
    }).then((unlisten) => {
      if (lifecycle.active) selectionUnlisten = unlisten
      else unlisten()
    })
    void Promise.all([desktop.loadSettings(), desktop.takeTranslatorSelection()]).then(([loaded, selected]) => {
      if (!lifecycle.active) return
      setSettings(loaded)
      setInput(selected)
      queueMicrotask(() => inputRef.current?.focus())
    }).catch((reason: unknown) => {
      if (lifecycle.active) setError(String(reason))
    })
    return () => {
      lifecycle.active = false
      prepareUnlisten?.()
      selectionUnlisten?.()
      generation.current += 1
    }
  }, [desktop])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void desktop.hideWindow()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [desktop])
  useEffect(() => {
    const syncSelection = () => {
      void desktop.takeTranslatorSelection().then((selected) => {
        setInput(selected)
        queueMicrotask(() => inputRef.current?.focus())
      }).catch((reason: unknown) => setError(String(reason)))
    }
    window.addEventListener('focus', syncSelection)
    return () => window.removeEventListener('focus', syncSelection)
  }, [desktop])
  useEffect(() => {
    if (settings === null || input.trim().length === 0) return
    const requestKey = translationRequestKey(input, settings)
    const delay = immediateRequest.current === requestKey ? 0 : 600
    if (delay === 0) immediateRequest.current = null
    const requestGeneration = generation.current + 1
    generation.current = requestGeneration
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      void desktop.translate({
        text: input,
        method: settings.translation.method,
        sourceLanguage: settings.translation.sourceLanguage,
        targetLanguage: settings.translation.targetLanguage,
        generation: requestGeneration,
      }).then((result) => {
        if (result.generation !== generation.current) return
        setOutput(result.text)
        setLoading(false)
        const entry: TranslationHistory = {
          id: roundId.current,
          input,
          output: result.text,
          method: settings.translation.method,
          updatedAt: Date.now(),
        }
        setHistory((items) => saveHistory(localStorage, historyKey, upsertHistory(items, entry)))
      }).catch((reason: unknown) => {
        if (requestGeneration !== generation.current) return
        setLoading(false)
        setError(String(reason))
      })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [desktop, input, settings])
  const updateTranslationSettings = (patch: TranslationSettingsPatch) => {
    if (settings === null) return
    const translation = { ...settings.translation, ...patch }
    const next = normalizeAiAvailability({ ...settings, translation })
    immediateRequest.current = translationRequestKey(input, next)
    generation.current += 1
    setOutput('')
    setLoading(false)
    setError(null)
    setSettings(next)
    void desktop.updateTranslationSettings(patch).catch((reason: unknown) => setError(String(reason)))
  }
  const updateInput = (value: string) => {
    setInput(value)
    if (value.trim().length === 0) {
      generation.current += 1
      setOutput('')
      setLoading(false)
      setError(null)
      roundId.current = crypto.randomUUID()
    }
  }
  const commit = async () => {
    const text = output.trim().length > 0 ? output : input
    if (text.trim().length === 0) return
    await desktop.commitText(text, settings?.general.autoPaste ?? false)
    await desktop.hideWindow()
  }
  const canUseAi = settings !== null
    && settings.translation.aiEnabled
    && isValidModelSelection(settings.translation.aiModel, settings.providers)
  const selectedMethod = settings?.translation.method === 'ai' && !canUseAi
    ? DEFAULT_SETTINGS.translation.method
    : settings?.translation.method ?? 'microsoft'
  const availableMethods = translationMethodOptions.filter((option) => option.value !== 'ai' || canUseAi)
  return (
    <main
      key={arrivalCycle}
      className="translator-window ocr-result-card screenpilot-jelly-pop"
      data-screenpilot-window-frame="true"
      data-screenpilot-ocr-card="true"
    >
      <header className="ocr-result-header" onPointerDown={beginWindowDrag}>
        <div className="ocr-result-identity">
          <span className="ocr-result-mark"><Languages size={15} /></span>
          <h1>文本翻译</h1>
        </div>
        <span className="ocr-result-status" aria-live="polite">
          {loading ? '翻译中…' : input.trim().length > 0 ? 'Ctrl+Enter 提交' : '等待输入'}
        </span>
        <div className="ocr-result-header-actions">
          <button type="button" className="ocr-header-button" aria-label="翻译历史" onClick={() => setHistoryOpen(!historyOpen)}>
            <Clock3 size={16} />
          </button>
          <button type="button" className="ocr-header-button" aria-label="关闭翻译" onClick={() => void desktop.hideWindow()}>
            <X size={14} />
          </button>
        </div>
      </header>
      <div
        className="ocr-result-body translator-split-body"
        style={{ gridTemplateRows: `${String(ratio)}fr 9px ${String(1 - ratio)}fr` }}
      >
        <section className="ocr-result-section ocr-result-source">
          <div className="ocr-result-section-heading">
            <label htmlFor="translator-input">原文</label>
            <select
              aria-label="源语言"
              className="translator-language-select"
              value={settings?.translation.sourceLanguage ?? 'auto'}
              disabled={settings === null}
              onChange={(event) => {
                if (settings === null) return
                updateTranslationSettings({ sourceLanguage: event.target.value as TranslationLanguage })
              }}
            >
              {sourceLanguageOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </div>
          <textarea
            ref={inputRef}
            id="translator-input"
            value={input}
            placeholder="输入或通过 F2 获取当前选中文本"
            onChange={(event) => updateInput(event.target.value)}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !composing.current) {
                event.preventDefault()
                void commit()
              }
            }}
          />
        </section>
        <button
          type="button"
          role="separator"
          className="ocr-result-divider translator-split-divider"
          aria-label="调整原文和译文高度"
          aria-orientation="horizontal"
          aria-valuemin={24}
          aria-valuemax={76}
          aria-valuenow={Math.round(ratio * 100)}
          onPointerDown={beginResize}
        >
          <span />
        </button>
        <section className="ocr-result-section ocr-result-output">
          <div className="ocr-result-section-heading">
            <label>译文</label>
            <button
              type="button"
              className="ocr-section-button"
              aria-label="复制译文"
              disabled={output.length === 0}
              onClick={() => {
                void navigator.clipboard.writeText(output).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1200)
                })
              }}
            >
              {copied ? <Check size={15} /> : <Clipboard size={15} />}
            </button>
            <select
              aria-label="目标语言"
              className="translator-language-select"
              value={settings?.translation.targetLanguage ?? 'auto'}
              disabled={settings === null}
              onChange={(event) => {
                if (settings === null) return
                updateTranslationSettings({ targetLanguage: event.target.value })
              }}
            >
              {targetLanguageOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
            <select
              aria-label="翻译接口"
              value={selectedMethod}
              disabled={settings === null}
              onChange={(event) => {
                if (settings === null) return
                const method = event.target.value as TranslationMethod
                updateTranslationSettings({ method })
              }}
            >
              {availableMethods.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </div>
          {loading ? <div className="ocr-result-skeleton"><span /><span /><span /></div> : null}
          {!loading && error !== null ? <div className="ocr-result-error" role="alert">{error}</div> : null}
          {!loading && error === null ? (
            <textarea
              id="translator-output"
              aria-label="译文"
              value={output}
              placeholder="译文将在这里显示，可直接编辑"
              onChange={(event) => setOutput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !composing.current) {
                  event.preventDefault()
                  void commit()
                }
              }}
            />
          ) : null}
        </section>
      </div>
      {historyOpen ? (
        <aside className="history-popover ocr-history-popover" aria-label="翻译历史">
          <header><strong>最近翻译</strong><button type="button" className="text-button" onClick={() => { setHistory([]); saveHistory(localStorage, historyKey, []) }}>清空</button></header>
          <div>
            {history.length === 0 ? <p>暂无历史</p> : history.map((item) => (
              <article key={item.id}>
                <button type="button" onClick={() => { setInput(item.input); setOutput(item.output); roundId.current = item.id; setHistoryOpen(false) }}>
                  <strong>{item.input}</strong><span>{item.output}</span>
                </button>
                <button type="button" className="icon-button" aria-label="删除历史" onClick={() => setHistory((items) => saveHistory(localStorage, historyKey, items.filter((entry) => entry.id !== item.id)))}><Trash2 size={13} /></button>
              </article>
            ))}
          </div>
        </aside>
      ) : null}
    </main>
  )
}
