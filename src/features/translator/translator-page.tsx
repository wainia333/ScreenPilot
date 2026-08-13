import { Check, Clipboard, Languages, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDesktop } from '../../desktop/use-desktop'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'
import { translationMethodOptions } from '../settings/translation-methods'
import type { AppSettings, TranslationLanguage, TranslationMethod } from '../settings/types'
import { isValidModelSelection, normalizeAiAvailability } from '../settings/sanitize'
import { DEFAULT_SETTINGS } from '../settings/defaults'
import type { TranslationSettingsPatch, Unlisten } from '../../desktop/contract'
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

type TranslatorListenerKind = 'prepare' | 'selection'
type TranslatorListenerErrors = Partial<Record<TranslatorListenerKind, string>>
type TranslatorListenerState = Record<TranslatorListenerKind, boolean>

const translationSettingKeys = ['method', 'sourceLanguage', 'targetLanguage'] as const

function translationSettingsDiff(
  confirmed: AppSettings,
  desired: AppSettings,
): TranslationSettingsPatch {
  const patch: TranslationSettingsPatch = {}
  translationSettingKeys.forEach((key) => {
    if (confirmed.translation[key] !== desired.translation[key]) {
      Object.assign(patch, { [key]: desired.translation[key] })
    }
  })
  return patch
}

function translatorRecoveryCopy(language: AppSettings['language']) {
  return language === 'en'
    ? {
        prepare: 'Window activation updates are unavailable.',
        selection: 'Selected-text updates are unavailable.',
        settings: 'The setting could not be saved. The last saved options were restored.',
      }
    : {
        prepare: '窗口唤起同步暂不可用。',
        selection: '选中文本同步暂不可用。',
        settings: '设置保存失败，已恢复上次保存的选项。',
      }
}

const historyKey = 'screenpilot:translator-history'
export const TRANSLATOR_INPUT_DEBOUNCE_MS = 1500
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
  const [outputInput, setOutputInput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [listenerErrors, setListenerErrors] = useState<TranslatorListenerErrors>({})
  const [listenerRetrying, setListenerRetrying] = useState<TranslatorListenerState>({
    prepare: false,
    selection: false,
  })
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
  const copyRequest = useRef(0)
  const componentActive = useRef(false)
  const confirmedSettings = useRef<AppSettings | null>(null)
  const desiredSettings = useRef<AppSettings | null>(null)
  const pendingSettings = useRef<AppSettings | null>(null)
  const settingsWriteTask = useRef<Promise<void> | null>(null)
  const listenerInstallers = useRef<Record<TranslatorListenerKind, () => Promise<boolean>>>(
    {
      prepare: () => Promise.resolve(false),
      selection: () => Promise.resolve(false),
    },
  )
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
  const hideTranslator = useCallback(async () => {
    cancelTranslation()
    try {
      await desktop.hideWindow()
    } catch (reason) {
      setLoading(false)
      setError(String(reason))
    }
  }, [cancelTranslation, desktop])
  useEffect(() => {
    document.documentElement.lang = interfaceLanguage === 'zh' ? 'zh-CN' : 'en'
    document.title = `ScreenPilot — ${t.translatorTitle}`
    if ('__TAURI_INTERNALS__' in window) {
      void getCurrentWindow().setTitle(document.title).catch((reason: unknown) => {
        console.error('[translator] failed to set window title', reason)
      })
    }
  }, [interfaceLanguage, t.translatorTitle])
  const flushTranslationSettings = useCallback((): Promise<void> => {
    if (settingsWriteTask.current !== null) return settingsWriteTask.current
    const run = async () => {
      while (pendingSettings.current !== null) {
        const target = pendingSettings.current
        const confirmed = confirmedSettings.current
        pendingSettings.current = null
        if (confirmed === null) break
        const patch = translationSettingsDiff(confirmed, target)
        if (Object.keys(patch).length === 0) {
          confirmedSettings.current = target
          continue
        }
        try {
          await desktop.updateTranslationSettings(patch)
          confirmedSettings.current = target
          if (componentActive.current && desiredSettings.current === target) {
            setSettings(target)
            setSettingsError(null)
          }
        } catch (reason) {
          let rollback = confirmed
          try {
            rollback = await desktop.loadSettings()
          } catch (loadReason) {
            console.error('[translator] failed to reload settings after an update failure', loadReason)
          }
          pendingSettings.current = null
          confirmedSettings.current = rollback
          desiredSettings.current = rollback
          if (componentActive.current) {
            cancelTranslation()
            immediateRequest.current = translationRequestKey(inputRef.current?.value ?? '', rollback)
            setOutput('')
            setLoading(false)
            setSettings(rollback)
            setSettingsError(`${translatorRecoveryCopy(rollback.language).settings} ${String(reason)}`)
          }
          break
        }
      }
    }
    const task = run().finally(() => {
      if (settingsWriteTask.current === task) settingsWriteTask.current = null
    })
    settingsWriteTask.current = task
    return task
  }, [cancelTranslation, desktop])
  useEffect(() => {
    const lifecycle = { active: true }
    const unlisteners: Record<TranslatorListenerKind, Unlisten | null> = {
      prepare: null,
      selection: null,
    }
    const attempts: Record<TranslatorListenerKind, number> = {
      prepare: 0,
      selection: 0,
    }
    const registrations: Record<TranslatorListenerKind, Promise<boolean> | null> = {
      prepare: null,
      selection: null,
    }
    componentActive.current = true

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
      setOutputInput(null)
      setError(null)
      setLoading(false)
      copyRequest.current += 1
      setCopied(false)
      setCopyError(null)
      focusInput()
    }
    const refreshSettings = () => {
      const request = settingsRequest.current + 1
      settingsRequest.current = request
      if (settingsWriteTask.current === null) setSettings(null)
      void flushTranslationSettings().then(() => desktop.loadSettings()).then((loaded) => {
        if (lifecycle.active && request === settingsRequest.current) {
          syncDocumentTheme(loaded.theme)
          confirmedSettings.current = loaded
          desiredSettings.current = loaded
          pendingSettings.current = null
          setSettingsError(null)
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
    const onPrepare = () => {
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
      setOutputInput(null)
      setError(null)
      setLoading(false)
      copyRequest.current += 1
      setCopied(false)
      setCopyError(null)
      setArrivalCycle((value) => value + 1)
      refreshSettings()
    }
    const onSelection = (selected: string) => {
      if (!lifecycle.active) return
      selectionRequest.current += 1
      applySelection(selected)
    }
    const installListener = (kind: TranslatorListenerKind): Promise<boolean> => {
      if (!lifecycle.active || unlisteners[kind] !== null) return Promise.resolve(true)
      if (registrations[kind] !== null) return registrations[kind]
      const attempt = attempts[kind] + 1
      attempts[kind] = attempt
      setListenerRetrying((current) => ({ ...current, [kind]: true }))
      const registration = Promise.resolve()
        .then(() => kind === 'prepare'
          ? desktop.onTranslatorPrepare(onPrepare)
          : desktop.onTranslatorSelection(onSelection))
        .then((unlisten) => {
          if (!lifecycle.active || attempt !== attempts[kind]) {
            unlisten()
            return false
          }
          unlisteners[kind] = unlisten
          setListenerErrors((current) => {
            if (current[kind] === undefined) return current
            return kind === 'prepare'
              ? { ...(current.selection === undefined ? {} : { selection: current.selection }) }
              : { ...(current.prepare === undefined ? {} : { prepare: current.prepare }) }
          })
          return true
        })
        .catch((reason: unknown) => {
          console.error(`[translator] failed to register ${kind} listener`, reason)
          if (lifecycle.active && attempt === attempts[kind]) {
            setListenerErrors((current) => ({ ...current, [kind]: String(reason) }))
          }
          return false
        })
        .finally(() => {
          if (registrations[kind] === registration) registrations[kind] = null
          if (lifecycle.active && attempt === attempts[kind]) {
            setListenerRetrying((current) => ({ ...current, [kind]: false }))
          }
        })
      registrations[kind] = registration
      return registration
    }
    listenerInstallers.current = {
      prepare: () => installListener('prepare'),
      selection: () => installListener('selection'),
    }

    void installListener('prepare')
    void installListener('selection')
    refreshSettings()
    syncStoredSelection()
    window.addEventListener('focus', syncStoredSelection)
    return () => {
      lifecycle.active = false
      componentActive.current = false
      attempts.prepare += 1
      attempts.selection += 1
      unlisteners.prepare?.()
      unlisteners.selection?.()
      unlisteners.prepare = null
      unlisteners.selection = null
      listenerInstallers.current = {
        prepare: () => Promise.resolve(false),
        selection: () => Promise.resolve(false),
      }
      window.removeEventListener('focus', syncStoredSelection)
      settingsRequest.current += 1
      selectionRequest.current += 1
      copyRequest.current += 1
      cancelTranslation()
    }
  }, [cancelTranslation, desktop, flushTranslationSettings])
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
        setOutputInput(input)
        copyRequest.current += 1
        setCopied(false)
        setCopyError(null)
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
    desiredSettings.current = next
    pendingSettings.current = next
    immediateRequest.current = translationRequestKey(input, next)
    cancelTranslation()
    setOutput('')
    setOutputInput(null)
    setLoading(false)
    setError(null)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    setSettingsError(null)
    setSettings(next)
    void flushTranslationSettings()
  }
  const updateInput = (value: string) => {
    if (value === input) return
    inputRevision.current += 1
    cancelTranslation()
    immediateRequest.current = null
    skipNextInputRequest.current = null
    setInput(value)
    if (value.trim().length === 0) {
      setOutput('')
    }
    setOutputInput(null)
    setLoading(false)
    setError(null)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    if (value.trim().length === 0) {
      roundId.current = crypto.randomUUID()
    }
  }
  const commit = async () => {
    const text = outputInput === input && output.trim().length > 0 ? output : input
    if (text.trim().length === 0) return
    cancelTranslation()
    setError(null)
    try {
      await desktop.commitText(text, settings?.general.autoPaste ?? false)
    } catch (reason) {
      setLoading(false)
      setError(String(reason))
    }
  }
  const restoreHistory = (item: TranslationHistory) => {
    inputRevision.current += 1
    cancelTranslation()
    immediateRequest.current = null
    skipNextInputRequest.current = item.input === input ? null : item.input
    setInput(item.input)
    setOutput(item.output)
    setOutputInput(item.input)
    setError(null)
    setLoading(false)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
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
  const retryListener = (kind: TranslatorListenerKind) => {
    if (listenerRetrying[kind]) return
    void listenerInstallers.current[kind]()
  }
  const recoveryCopy = translatorRecoveryCopy(interfaceLanguage)
  const copyOutput = async () => {
    const request = copyRequest.current + 1
    copyRequest.current = request
    try {
      await navigator.clipboard.writeText(output)
      if (request !== copyRequest.current) return
      setCopyError(null)
      setCopied(true)
      window.setTimeout(() => {
        if (request === copyRequest.current) setCopied(false)
      }, 1200)
    } catch {
      if (request !== copyRequest.current) return
      setCopied(false)
      setCopyError(t.copyFailed)
    }
  }
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
          {copyError ?? (loading ? t.translating : input.trim().length > 0 ? t.submitShortcut : t.waitingForInput)}
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
      {settingsError === null && Object.keys(listenerErrors).length === 0 ? null : (
        <aside className="mx-3 mt-2 shrink-0 rounded-lg bg-white/95 px-3 py-2 text-[11px] text-red-600 shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-red-400 dark:ring-white/10" role="alert">
          {settingsError === null ? null : <p className="break-words">{settingsError}</p>}
          {(['prepare', 'selection'] as const).map((kind) => listenerErrors[kind] === undefined ? null : (
            <div className="flex items-center gap-2" key={kind}>
              <span className="min-w-0 flex-1 break-words">{recoveryCopy[kind]} {listenerErrors[kind]}</span>
              <button
                type="button"
                className="text-button h-6 shrink-0 px-1"
                disabled={listenerRetrying[kind]}
                onClick={() => retryListener(kind)}
              >
                {listenerRetrying[kind] ? `${t.retry}…` : t.retry}
              </button>
            </div>
          ))}
        </aside>
      )}
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
              disabled={output.length === 0 || outputInput !== input}
              onClick={() => void copyOutput()}
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
          {loading && output.length === 0 ? <div className="ocr-result-skeleton"><span /><span /><span /></div> : null}
          {!loading && error !== null ? <div className="ocr-result-error" role="alert">{error}</div> : null}
          {error === null && (!loading || output.length > 0) ? (
            <textarea
              id="translator-output"
              aria-label={t.translatedText}
              value={output}
              placeholder={t.translatedTextPlaceholder}
              onChange={(event) => {
                copyRequest.current += 1
                setOutput(event.target.value)
                setOutputInput(input)
                setCopied(false)
                setCopyError(null)
              }}
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
