import { Check, Clipboard, Languages, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDesktop } from '../../desktop/use-desktop'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'
import { translationMethodOptions } from '../settings/translation-methods'
import type { AppSettings, TranslationLanguage, TranslationMethod } from '../settings/types'
import { isValidModelSelection, normalizeAiAvailability } from '../settings/sanitize'
import { DEFAULT_SETTINGS } from '../settings/defaults'
import type { TranslationSettingsPatch } from '../../desktop/contract'
import { useSplitRatio } from '../../shared/hooks/use-split-ratio'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { HistoryMenu } from '../history/history-menu'
import { copyFor, translationLanguageOptions, translationMethodLabel } from '../../shared/ui-copy'
import { syncDocumentTheme } from '../../shared/theme'
import { nextTranslationGeneration } from './translation-generation'

type TargetLanguage = TranslationLanguage

type TranslationHistory = {
  id: string
  input: string
  output: string
  method: TranslationMethod
  updatedAt: number
}

const historyKey = 'screenpilot:translator-history'
export const TRANSLATOR_INPUT_DEBOUNCE_MS = 700
const goldenSectionRatio = (3 - Math.sqrt(5)) / 2
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
  const [copied, setCopied] = useState(false)
  const [arrivalCycle, setArrivalCycle] = useState(0)
  const [history, setHistory] = useState(() => loadHistory(localStorage, historyKey, validHistory))
  const activeGeneration = useRef(0)
  const inputRevision = useRef(0)
  const settingsRequest = useRef(0)
  const selectionRequest = useRef(0)
  const lastAppliedSelection = useRef<string | null>(null)
  const roundId = useRef<string>(crypto.randomUUID())
  const composing = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const immediateRequest = useRef<string | null>(null)
  const skipNextInputRequest = useRef<string | null>(null)
  const { ratio, beginResize, resizeByKeyboard } = useSplitRatio(
    'screenpilot:translator-ocr-golden-split',
    goldenSectionRatio,
  )
  const interfaceLanguage = settings?.language ?? 'zh'
  const t = copyFor(interfaceLanguage)
  const sourceLanguageOptions = translationLanguageOptions(interfaceLanguage)
  const targetLanguageOptions: { value: TargetLanguage; label: string }[] = sourceLanguageOptions
  const cancelTranslation = useCallback(() => {
    const cancelGeneration = nextTranslationGeneration()
    activeGeneration.current = cancelGeneration
    void desktop.cancelTranslation(cancelGeneration).catch((reason: unknown) => {
      console.error('[translator] failed to cancel active translation', reason)
    })
    return cancelGeneration
  }, [desktop])
  const hideTranslator = useCallback(() => {
    cancelTranslation()
    return desktop.hideWindow()
  }, [cancelTranslation, desktop])
  useEffect(() => {
    document.documentElement.lang = interfaceLanguage === 'zh' ? 'zh-CN' : 'en'
    document.title = `ScreenPilot — ${t.translatorTitle}`
    if ('__TAURI_INTERNALS__' in window) void getCurrentWindow().setTitle(document.title)
  }, [interfaceLanguage, t.translatorTitle])
  useEffect(() => {
    const lifecycle = { active: true }
    let prepareUnlisten: (() => void) | undefined
    let selectionUnlisten: (() => void) | undefined

    const focusInput = () => {
      queueMicrotask(() => {
        if (lifecycle.active) inputRef.current?.focus()
      })
    }
    const applySelection = (selected: string) => {
      if (!lifecycle.active || lastAppliedSelection.current === selected) return
      lastAppliedSelection.current = selected
      inputRevision.current += 1
      cancelTranslation()
      immediateRequest.current = null
      skipNextInputRequest.current = null
      roundId.current = crypto.randomUUID()
      setInput(selected)
      setOutput('')
      setError(null)
      setLoading(false)
      setCopied(false)
      focusInput()
    }
    const refreshSettings = () => {
      const request = settingsRequest.current + 1
      settingsRequest.current = request
      setSettings(null)
      void desktop.loadSettings().then((loaded) => {
        if (lifecycle.active && request === settingsRequest.current) {
          syncDocumentTheme(loaded.theme)
          setSettings(loaded)
        }
      }).catch((reason: unknown) => {
        if (lifecycle.active && request === settingsRequest.current) setError(String(reason))
      })
    }
    const syncStoredSelection = () => {
      const request = selectionRequest.current + 1
      const revision = inputRevision.current
      selectionRequest.current = request
      void desktop.takeTranslatorSelection().then((selected) => {
        if (
          !lifecycle.active
          || request !== selectionRequest.current
          || revision !== inputRevision.current
        ) return
        applySelection(selected)
      }).catch((reason: unknown) => {
        if (lifecycle.active && request === selectionRequest.current) setError(String(reason))
      })
    }

    void desktop.onTranslatorPrepare(() => {
      if (!lifecycle.active) return
      inputRevision.current += 1
      cancelTranslation()
      selectionRequest.current += 1
      lastAppliedSelection.current = null
      immediateRequest.current = null
      skipNextInputRequest.current = null
      roundId.current = crypto.randomUUID()
      setInput('')
      setOutput('')
      setError(null)
      setLoading(false)
      setCopied(false)
      setArrivalCycle((value) => value + 1)
      refreshSettings()
    }).then((unlisten) => {
      if (lifecycle.active) prepareUnlisten = unlisten
      else unlisten()
    })
    void desktop.onTranslatorSelection((selected) => {
      if (!lifecycle.active) return
      selectionRequest.current += 1
      applySelection(selected)
    }).then((unlisten) => {
      if (lifecycle.active) selectionUnlisten = unlisten
      else unlisten()
    })
    refreshSettings()
    syncStoredSelection()
    window.addEventListener('focus', syncStoredSelection)
    return () => {
      lifecycle.active = false
      prepareUnlisten?.()
      selectionUnlisten?.()
      window.removeEventListener('focus', syncStoredSelection)
      settingsRequest.current += 1
      selectionRequest.current += 1
      cancelTranslation()
    }
  }, [cancelTranslation, desktop])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void hideTranslator()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [hideTranslator])
  useEffect(() => {
    if (settings === null || input.trim().length === 0) return
    if (skipNextInputRequest.current === input) {
      skipNextInputRequest.current = null
      return
    }
    const requestKey = translationRequestKey(input, settings)
    const delay = immediateRequest.current === requestKey ? 0 : TRANSLATOR_INPUT_DEBOUNCE_MS
    if (delay === 0) immediateRequest.current = null
    const requestGeneration = nextTranslationGeneration()
    activeGeneration.current = requestGeneration
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
        if (result.generation !== activeGeneration.current) return
        setOutput(result.text)
        setCopied(false)
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
        if (requestGeneration !== activeGeneration.current) return
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
    cancelTranslation()
    setOutput('')
    setLoading(false)
    setError(null)
    setCopied(false)
    setSettings(next)
    void desktop.updateTranslationSettings(patch).catch((reason: unknown) => setError(String(reason)))
  }
  const updateInput = (value: string) => {
    if (value === input) return
    inputRevision.current += 1
    cancelTranslation()
    immediateRequest.current = null
    skipNextInputRequest.current = null
    setInput(value)
    setOutput('')
    setLoading(false)
    setError(null)
    setCopied(false)
    if (value.trim().length === 0) {
      roundId.current = crypto.randomUUID()
    }
  }
  const commit = async () => {
    const text = output.trim().length > 0 ? output : input
    if (text.trim().length === 0) return
    cancelTranslation()
    await desktop.commitText(text, settings?.general.autoPaste ?? false)
    await desktop.hideWindow()
  }
  const restoreHistory = (item: TranslationHistory) => {
    inputRevision.current += 1
    cancelTranslation()
    immediateRequest.current = null
    skipNextInputRequest.current = item.input === input ? null : item.input
    setInput(item.input)
    setOutput(item.output)
    setError(null)
    setLoading(false)
    setCopied(false)
    roundId.current = item.id
    queueMicrotask(() => inputRef.current?.focus())
  }
  const canUseAi = settings !== null
    && settings.translation.aiEnabled
    && isValidModelSelection(settings.translation.aiModel, settings.providers)
  const selectedMethod = settings?.translation.method === 'ai' && !canUseAi
    ? DEFAULT_SETTINGS.translation.method
    : settings?.translation.method ?? 'microsoft'
  const availableMethods = translationMethodOptions
    .filter((option) => option.value !== 'ai' || canUseAi)
    .map((option) => ({ ...option, label: translationMethodLabel(option.value, interfaceLanguage) }))
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
          <h1>{t.translatorTitle}</h1>
        </div>
        <span className="ocr-result-status" aria-live="polite">
          {loading ? t.translating : input.trim().length > 0 ? t.submitShortcut : t.waitingForInput}
        </span>
        <div className="ocr-result-header-actions">
          <HistoryMenu
            items={history}
            title={t.translationHistory}
            countAnnouncementId="translator-history-count"
            language={interfaceLanguage}
            getMeta={(item) => translationMethodLabel(item.method, interfaceLanguage)}
            onRestore={restoreHistory}
            onRemove={(id) => setHistory((items) => saveHistory(localStorage, historyKey, items.filter((entry) => entry.id !== id)))}
            onClear={() => setHistory((items) => saveHistory(localStorage, historyKey, items.length === 0 ? items : []))}
          />
          <button type="button" className="ocr-header-button" aria-label={t.closeTranslator} onClick={() => void hideTranslator()}>
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
            <label htmlFor="translator-input">{t.originalText}</label>
            <select
              aria-label={t.sourceLanguage}
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
            placeholder={t.translatorInputPlaceholder}
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
          aria-label={t.resizeTranslationPanels}
          aria-orientation="horizontal"
          aria-valuemin={24}
          aria-valuemax={76}
          aria-valuenow={Math.round(ratio * 100)}
          onPointerDown={beginResize}
          onKeyDown={resizeByKeyboard}
        >
          <span />
        </button>
        <section className="ocr-result-section ocr-result-output">
          <div className="ocr-result-section-heading">
            <label>{t.translatedText}</label>
            <button
              type="button"
              className="ocr-section-button"
              aria-label={t.copyTranslation}
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
              aria-label={t.targetLanguage}
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
              aria-label={t.translationInterface}
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
              aria-label={t.translatedText}
              value={output}
              placeholder={t.translatedTextPlaceholder}
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
    </main>
  )
}
