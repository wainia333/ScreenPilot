import { Check, Clipboard, Languages, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDesktop } from '../../desktop/use-desktop'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'
import { translationMethodOptions } from '../settings/translation-methods'
import type {
  AppSettings,
  ModelSelection,
  TranslationLanguage,
  TranslationMethod,
} from '../settings/types'
import { isValidModelSelection, normalizeAiAvailability } from '../settings/sanitize'
import { DEFAULT_SETTINGS } from '../settings/defaults'
import type { TranslationSettingsPatch, Unlisten } from '../../desktop/contract'
import { useSplitRatio } from '../../shared/hooks/use-split-ratio'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { HistoryMenu } from '../history/history-menu'
import { copyFor, translationLanguageOptions, translationMethodLabel } from '../../shared/ui-copy'
import { syncDocumentTheme } from '../../shared/theme'
import { nextTranslationGeneration } from './translation-generation'
import { NoticeContent } from '../../shared/ui/top-notice'

type TargetLanguage = TranslationLanguage

type TranslationHistorySession = {
  sourceLanguage: TranslationLanguage
  targetLanguage: string
  method: TranslationMethod
  model: ModelSelection | null
}

type TranslationHistory = {
  id: string
  input: string
  output: string
  schemaVersion: 1
  sourceLanguage: TranslationLanguage | null
  targetLanguage: string | null
  method: string
  model: ModelSelection | null
  originalOutput?: string
  updatedAt: number
}

type StoredTranslationHistory = {
  id: string
  input: string
  output: string
  method: string
  updatedAt: number
  schemaVersion?: number
  sourceLanguage?: string
  targetLanguage?: string
  model?: unknown
  originalOutput?: string
}

type TranslatorListenerKind = 'prepare' | 'selection'
type TranslatorListenerErrors = Partial<Record<TranslatorListenerKind, string>>
type TranslatorListenerState = Record<TranslatorListenerKind, boolean>
type TranslatorSelectionDelivery = 'event' | 'snapshot'

type AppliedTranslatorSelection = {
  text: string
  delivery: TranslatorSelectionDelivery
}

type TranslationFailureKind = 'unconfigured' | 'network' | 'authentication' | 'cancelled' | 'unknown'

type TranslationFailure = {
  kind: TranslationFailureKind
  detail: string
}

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
const supportedTranslationLanguages: readonly TranslationLanguage[] = ['auto', 'zh-CN', 'en', 'ja', 'ko']

function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && supportedTranslationLanguages.includes(value as TranslationLanguage)
}

function isTranslationMethod(value: string): value is TranslationMethod {
  return translationMethodOptions.some((option) => option.value === value)
}

function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null) return false
  const model = value as Partial<ModelSelection>
  return typeof model.providerId === 'string'
    && model.providerId.trim().length > 0
    && typeof model.model === 'string'
    && model.model.trim().length > 0
}

function translationRequestKey(input: string, session: TranslationHistorySession): string {
  return JSON.stringify([
    input,
    session.method,
    session.sourceLanguage,
    session.targetLanguage,
  ])
}

function validHistory(value: unknown): value is StoredTranslationHistory {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<StoredTranslationHistory>
  return (
    typeof item.id === 'string' &&
    typeof item.input === 'string' &&
    typeof item.output === 'string' &&
    typeof item.method === 'string' &&
    item.method.length > 0 &&
    typeof item.updatedAt === 'number' &&
    (item.schemaVersion === undefined || item.schemaVersion === 1) &&
    (item.sourceLanguage === undefined || typeof item.sourceLanguage === 'string') &&
    (item.targetLanguage === undefined || typeof item.targetLanguage === 'string') &&
    (item.model === undefined || item.model === null || isModelSelection(item.model))
  )
}

function normalizeHistory(item: StoredTranslationHistory): TranslationHistory {
  const versioned = item.schemaVersion === 1
  const sourceLanguage = versioned && isTranslationLanguage(item.sourceLanguage)
    ? item.sourceLanguage
    : null
  const targetLanguage = versioned && typeof item.targetLanguage === 'string' && item.targetLanguage.length > 0
    ? item.targetLanguage
    : null
  return {
    id: item.id,
    input: item.input,
    output: item.output,
    schemaVersion: 1,
    sourceLanguage,
    targetLanguage,
    method: item.method,
    model: versioned && isModelSelection(item.model) ? item.model : null,
    ...(typeof item.originalOutput === 'string' ? { originalOutput: item.originalOutput } : {}),
    updatedAt: item.updatedAt,
  }
}

function technicalError(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) return reason.message
  if (typeof reason === 'string' && reason.trim().length > 0) return reason
  try {
    const serialized = JSON.stringify(reason)
    if (typeof serialized === 'string' && serialized.length > 0) return serialized
  } catch {
    // Fall through to the generic string representation below.
  }
  return String(reason)
}

function classifyTranslationFailure(reason: unknown): TranslationFailure {
  const detail = technicalError(reason)
  const normalized = detail.toLocaleLowerCase()
  if (/(cancel|abort|取消)/u.test(normalized)) {
    return { kind: 'cancelled', detail }
  }
  if (/(required|not configured|select .*model|no .*provider|disabled|must be configured|未配置|必须|请选择|禁用|凭据.*必需|密钥.*必需)/u.test(normalized)) {
    return { kind: 'unconfigured', detail }
  }
  if (/(401|403|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|access denied|认证|鉴权|密钥无效)/u.test(normalized)) {
    return { kind: 'authentication', detail }
  }
  if (/(network|timeout|timed out|connect|dns|resolve|fetch|connection|temporarily unavailable|\b5\d\d\b|网络|超时|连接|服务不可用)/u.test(normalized)) {
    return { kind: 'network', detail }
  }
  return { kind: 'unknown', detail }
}

function sessionFromHistory(item: TranslationHistory): TranslationHistorySession | null {
  if (
    item.sourceLanguage === null
    || item.targetLanguage === null
    || !isTranslationMethod(item.method)
    || (item.method === 'ai' && item.model === null)
  ) return null
  return {
    sourceLanguage: item.sourceLanguage,
    targetLanguage: item.targetLanguage,
    method: item.method,
    model: item.model,
  }
}

function settingsSession(settings: AppSettings): TranslationHistorySession {
  return {
    sourceLanguage: settings.translation.sourceLanguage,
    targetLanguage: settings.translation.targetLanguage,
    method: settings.translation.method,
    model: settings.translation.method === 'ai' ? settings.translation.aiModel : null,
  }
}

function historySourceLabel(item: TranslationHistory, language: AppSettings['language']): string {
  const t = copyFor(language)
  const method = isTranslationMethod(item.method)
    ? translationMethodLabel(item.method, language)
    : item.method
  if (item.sourceLanguage === null || item.targetLanguage === null) {
    return `${method} · ${t.translationLanguageUnknown}`
  }
  const languages = translationLanguageOptions(language)
  const source = languages.find((option) => option.value === item.sourceLanguage)?.label ?? item.sourceLanguage
  const target = languages.find((option) => option.value === item.targetLanguage)?.label ?? item.targetLanguage
  const model = item.method === 'ai'
    ? item.model === null
      ? ` · ${t.translationModelUnknown}`
      : ` · ${item.model.providerId}/${item.model.model}`
    : ''
  return `${method} · ${source} → ${target}${model}`
}

export function TranslatorPage() {
  const desktop = useDesktop()
  const beginWindowDrag = useWindowDrag()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [outputInput, setOutputInput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [translationFailure, setTranslationFailure] = useState<TranslationFailure | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [listenerErrors, setListenerErrors] = useState<TranslatorListenerErrors>({})
  const [listenerRetrying, setListenerRetrying] = useState<TranslatorListenerState>({
    prepare: false,
    selection: false,
  })
  const [arrivalCycle, setArrivalCycle] = useState(0)
  const [selectionCycle, setSelectionCycle] = useState(0)
  const [history, setHistory] = useState(() => (
    loadHistory(localStorage, historyKey, validHistory).map(normalizeHistory)
  ))
  const historyRef = useRef(history)
  const persistedHistoryRef = useRef(history)
  const activeHistoryId = useRef<string>(crypto.randomUUID())
  const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const [historyContext, setHistoryContext] = useState<TranslationHistory | null>(null)
  const historyEditTimer = useRef<number | null>(null)
  const pendingHistoryEdit = useRef<{ id: string; output: string } | null>(null)
  const activeHistorySession = useMemo(
    () => historyContext === null ? null : sessionFromHistory(historyContext),
    [historyContext],
  )
  useEffect(() => {
    historyRef.current = history
  }, [history])
  const persistHistory = useCallback((next: TranslationHistory[]) => {
    const result = saveHistory(localStorage, historyKey, next, persistedHistoryRef.current)
    historyRef.current = result.history
    setHistory(result.history)
    if (result.ok) {
      persistedHistoryRef.current = result.persistedHistory
      setHistorySaveFailed(false)
    } else {
      setHistorySaveFailed(true)
    }
  }, [])
  const retryHistorySave = useCallback(() => persistHistory(historyRef.current), [persistHistory])
  const flushHistoryEdit = useCallback(() => {
    if (historyEditTimer.current !== null) {
      window.clearTimeout(historyEditTimer.current)
      historyEditTimer.current = null
    }
    const pending = pendingHistoryEdit.current
    pendingHistoryEdit.current = null
    if (pending === null) return
    const next = historyRef.current.map((item) => item.id === pending.id
      ? { ...item, output: pending.output, updatedAt: Date.now() }
      : item)
    if (next.some((item, index) => item !== historyRef.current[index])) persistHistory(next)
  }, [persistHistory])
  const scheduleHistoryEdit = useCallback((output: string) => {
    pendingHistoryEdit.current = { id: activeHistoryId.current, output }
    if (historyEditTimer.current !== null) window.clearTimeout(historyEditTimer.current)
    historyEditTimer.current = window.setTimeout(() => {
      historyEditTimer.current = null
      flushHistoryEdit()
    }, 300)
  }, [flushHistoryEdit])
  const activeGeneration = useRef(0)
  const translationInFlight = useRef(false)
  const settingsLoadingRef = useRef(false)
  const inputRevision = useRef(0)
  const manualInputRevision = useRef(0)
  const settingsRequest = useRef(0)
  const selectionRequest = useRef(0)
  const lastAppliedSelection = useRef<AppliedTranslatorSelection | null>(null)
  const composing = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const immediateRequest = useRef<string | null>(null)
  const immediateSelectionInput = useRef<string | null>(null)
  const skipNextInputRequest = useRef<string | null>(null)
  const copyRequest = useRef(0)
  const commitRequest = useRef(0)
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
    translationInFlight.current = false
    void desktop.cancelTranslation(cancelGeneration).catch((reason: unknown) => {
      console.error('[translator] failed to cancel active translation', reason)
    })
    return cancelGeneration
  }, [desktop])
  const hideTranslator = useCallback(async () => {
    flushHistoryEdit()
    cancelTranslation()
    try {
      await desktop.hideWindow()
    } catch (reason) {
      setLoading(false)
      setError(String(reason))
    }
  }, [cancelTranslation, desktop, flushHistoryEdit])
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
            immediateRequest.current = translationRequestKey(
              inputRef.current?.value ?? '',
              settingsSession(rollback),
            )
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
  const executeTranslation = useCallback((text: string, requestSession: TranslationHistorySession): boolean => {
    if (text.trim().length === 0 || translationInFlight.current) return false
    const requestGeneration = nextTranslationGeneration()
    activeGeneration.current = requestGeneration
    translationInFlight.current = true
    setLoading(true)
    setError(null)
    setTranslationFailure(null)
    void desktop.translate({
      text,
      method: requestSession.method,
      sourceLanguage: requestSession.sourceLanguage,
      targetLanguage: requestSession.targetLanguage,
      generation: requestGeneration,
    }).then((result) => {
      if (requestGeneration !== activeGeneration.current || result.generation !== requestGeneration) return
      translationInFlight.current = false
      setOutput(result.text)
      setOutputInput(text)
      copyRequest.current += 1
      setCopied(false)
      setCopyError(null)
      setLoading(false)
      setTranslationFailure(null)
      const entry: TranslationHistory = {
        id: activeHistoryId.current,
        input: text,
        output: result.text,
        schemaVersion: 1,
        sourceLanguage: requestSession.sourceLanguage,
        targetLanguage: requestSession.targetLanguage,
        method: requestSession.method,
        model: requestSession.model,
        originalOutput: historyRef.current.find((item) => item.id === activeHistoryId.current)?.originalOutput ?? result.text,
        updatedAt: Date.now(),
      }
      persistHistory(upsertHistory(historyRef.current, entry))
    }).catch((reason: unknown) => {
      if (requestGeneration !== activeGeneration.current) return
      translationInFlight.current = false
      setLoading(false)
      setTranslationFailure(classifyTranslationFailure(reason))
    })
    return true
  }, [desktop, persistHistory])
  const reloadSettings = useCallback(() => {
    if (settingsLoadingRef.current) return
    const request = settingsRequest.current + 1
    settingsRequest.current = request
    settingsLoadingRef.current = true
    setSettingsLoading(true)
    setSettingsError(null)
    if (settingsWriteTask.current === null) setSettings(null)
    if (translationInFlight.current) {
      cancelTranslation()
      setLoading(false)
    }
    void flushTranslationSettings()
      .then(() => desktop.loadSettings())
      .then((loaded) => {
        if (!componentActive.current || request !== settingsRequest.current) return
        syncDocumentTheme(loaded.theme)
        confirmedSettings.current = loaded
        desiredSettings.current = loaded
        pendingSettings.current = null
        setSettingsError(null)
        setSettings(loaded)
      })
      .catch((reason: unknown) => {
        if (!componentActive.current || request !== settingsRequest.current) return
        setSettingsError(technicalError(reason))
      })
      .finally(() => {
        if (componentActive.current && request === settingsRequest.current) {
          settingsLoadingRef.current = false
          setSettingsLoading(false)
        }
      })
  }, [cancelTranslation, desktop, flushTranslationSettings])
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
    let pendingCaptureRevision: number | null = manualInputRevision.current

    const focusInput = () => {
      queueMicrotask(() => {
        if (lifecycle.active) inputRef.current?.focus()
      })
    }
    const applySelection = (
      selected: string,
      delivery: TranslatorSelectionDelivery,
    ) => {
      if (!lifecycle.active) return
      if (
        pendingCaptureRevision !== null
        && pendingCaptureRevision !== manualInputRevision.current
      ) return
      if (delivery === 'event' || selected.trim().length > 0) pendingCaptureRevision = null
      const lastApplied = lastAppliedSelection.current
      if (lastApplied?.text === selected) {
        if (delivery === 'snapshot') return
        if (lastApplied.delivery === 'snapshot') {
          // Snapshot recovery and the listener can deliver the same capture in
          // either order. Confirm its event ownership without translating it twice.
          lastAppliedSelection.current = { text: selected, delivery }
          focusInput()
          return
        }
      }
      lastAppliedSelection.current = { text: selected, delivery }
      inputRevision.current += 1
      flushHistoryEdit()
      cancelTranslation()
      immediateRequest.current = null
      immediateSelectionInput.current = selected.trim().length > 0 ? selected : null
      skipNextInputRequest.current = null
      activeHistoryId.current = crypto.randomUUID()
      setHistoryContext(null)
      setSelectionCycle((value) => value + 1)
      setInput(selected)
      setOutput('')
      setOutputInput(null)
      commitRequest.current += 1
      setError(null)
      setTranslationFailure(null)
      setLoading(false)
      copyRequest.current += 1
      setCopied(false)
      setCopyError(null)
      if (delivery === 'event' || selected.trim().length > 0) focusInput()
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
        applySelection(selected, 'snapshot')
      }).catch((reason: unknown) => {
        if (lifecycle.active && request === selectionRequest.current) setError(String(reason))
      })
    }
    const onPrepare = () => {
      if (!lifecycle.active) return
      flushHistoryEdit()
      pendingCaptureRevision = manualInputRevision.current
      inputRevision.current += 1
      cancelTranslation()
      selectionRequest.current += 1
      lastAppliedSelection.current = null
      immediateRequest.current = null
      immediateSelectionInput.current = null
      skipNextInputRequest.current = null
      activeHistoryId.current = crypto.randomUUID()
      setHistoryContext(null)
      setInput('')
      setOutput('')
      setOutputInput(null)
      commitRequest.current += 1
      setError(null)
      setTranslationFailure(null)
      setLoading(false)
      copyRequest.current += 1
      setCopied(false)
      setCopyError(null)
      setArrivalCycle((value) => value + 1)
      reloadSettings()
    }
    const onSelection = (selected: string) => {
      if (!lifecycle.active) return
      selectionRequest.current += 1
      applySelection(selected, 'event')
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

    const initialManualInputRevision = manualInputRevision.current
    void installListener('prepare')
    // A newly-created translator window can miss the selection event emitted
    // while its React tree is still mounting. Subscribe first, then read the
    // stored snapshot so either side of that race delivers the captured text.
    void installListener('selection').then(() => {
      if (
        lifecycle.active
        && initialManualInputRevision === manualInputRevision.current
      ) {
        syncStoredSelection()
      }
    })
    reloadSettings()
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
      settingsLoadingRef.current = false
      selectionRequest.current += 1
      copyRequest.current += 1
      flushHistoryEdit()
      cancelTranslation()
    }
  }, [cancelTranslation, desktop, flushHistoryEdit, reloadSettings])
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
    const requestSession = activeHistorySession ?? settingsSession(settings)
    const requestKey = translationRequestKey(input, requestSession)
    const selectionIsImmediate = immediateSelectionInput.current === input
    const delay = selectionIsImmediate || immediateRequest.current === requestKey
      ? 0
      : TRANSLATOR_INPUT_DEBOUNCE_MS
    if (delay === 0) immediateRequest.current = null
    const timer = window.setTimeout(() => {
      if (selectionIsImmediate && immediateSelectionInput.current === input) {
        immediateSelectionInput.current = null
      }
      executeTranslation(input, requestSession)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [activeHistorySession, executeTranslation, input, selectionCycle, settings])
  const updateTranslationSettings = (patch: TranslationSettingsPatch) => {
    if (settings === null) return
    flushHistoryEdit()
    const translation = { ...settings.translation, ...patch }
    const next = normalizeAiAvailability({ ...settings, translation })
    desiredSettings.current = next
    pendingSettings.current = next
    setHistoryContext(null)
    immediateRequest.current = translationRequestKey(input, settingsSession(next))
    cancelTranslation()
    setOutput('')
    setOutputInput(null)
    setLoading(false)
    setError(null)
    setTranslationFailure(null)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    setSettingsError(null)
    setSettings(next)
    void flushTranslationSettings()
  }
  const updateInput = (value: string) => {
    if (value === input) return
    flushHistoryEdit()
    inputRevision.current += 1
    manualInputRevision.current += 1
    cancelTranslation()
    immediateRequest.current = null
    immediateSelectionInput.current = null
    skipNextInputRequest.current = null
    setInput(value)
    if (value.trim().length === 0) {
      setOutput('')
    }
    setOutputInput(null)
    commitRequest.current += 1
    setLoading(false)
    setError(null)
    setTranslationFailure(null)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    if (value.trim().length === 0) {
      activeHistoryId.current = crypto.randomUUID()
    }
  }
  const commit = async () => {
    const text = outputInput === input && output.trim().length > 0 ? output : input
    if (text.trim().length === 0) return
    const request = commitRequest.current + 1
    commitRequest.current = request
    cancelTranslation()
    setError(null)
    try {
      await desktop.commitText(text, settings?.general.autoPaste ?? false)
    } catch (reason) {
      if (request !== commitRequest.current) return
      setLoading(false)
      setError(String(reason))
    }
  }
  const restoreHistory = (item: TranslationHistory) => {
    flushHistoryEdit()
    inputRevision.current += 1
    manualInputRevision.current += 1
    cancelTranslation()
    immediateRequest.current = null
    immediateSelectionInput.current = null
    // Restoring is a view/session operation. Even when the text is unchanged,
    // changing the history context must not kick off a fresh translation.
    const current = historyRef.current.find((entry) => entry.id === item.id) ?? item
    skipNextInputRequest.current = current.input
    setHistoryContext(current)
    setInput(current.input)
    setOutput(current.output)
    setOutputInput(current.input)
    commitRequest.current += 1
    setError(null)
    setTranslationFailure(null)
    setLoading(false)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    activeHistoryId.current = current.id
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
  const retryTranslation = () => {
    if (settings === null || input.trim().length === 0 || translationInFlight.current) return
    executeTranslation(input, activeHistorySession ?? settingsSession(settings))
  }
  const recoveryCopy = translatorRecoveryCopy(interfaceLanguage)
  const translationFailureSummary = translationFailure === null
    ? null
    : {
        unconfigured: t.translationErrorUnconfigured,
        network: t.translationErrorNetwork,
        authentication: t.translationErrorAuthentication,
        cancelled: t.translationErrorCancelled,
        unknown: t.translationErrorUnknown,
      }[translationFailure.kind]
  const historyContextLabel = historyContext === null
    ? null
    : historySourceLabel(historyContext, interfaceLanguage)
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
            getMeta={(item) => historySourceLabel(item, interfaceLanguage)}
            onRestore={restoreHistory}
            onRemove={(id) => persistHistory(historyRef.current.filter((entry) => entry.id !== id))}
            onClear={() => persistHistory(historyRef.current.length === 0 ? historyRef.current : [])}
          />
          <button type="button" className="ocr-header-button" aria-label={t.closeTranslator} onClick={() => void hideTranslator()}>
            <X size={14} />
          </button>
        </div>
      </header>
      {historySaveFailed ? (
        <aside className="mx-3 mt-2 shrink-0 rounded-lg bg-white/95 px-3 py-2 text-[11px] text-red-600 shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-red-400 dark:ring-white/10" role="alert">
          <span>{t.historyNotSaved}</span>
          <button type="button" className="text-button ml-2 h-6 px-1" onClick={retryHistorySave}>{t.retryHistory}</button>
        </aside>
      ) : null}
      {settingsError === null && Object.keys(listenerErrors).length === 0 ? null : (
        <aside className="mx-3 mt-2 shrink-0 rounded-lg bg-white/95 px-3 py-2 text-[11px] text-red-600 shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-red-400 dark:ring-white/10" role="alert">
          {settingsError === null ? null : (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 break-words"><NoticeContent message={settingsError} language={interfaceLanguage} /></div>
              <button
                type="button"
                className="text-button h-6 shrink-0 px-1"
                disabled={settingsLoading}
                onClick={reloadSettings}
              >
                {settingsLoading ? t.reloadingSettings : t.reloadSettings}
              </button>
            </div>
          )}
          {(['prepare', 'selection'] as const).map((kind) => listenerErrors[kind] === undefined ? null : (
            <div className="flex items-center gap-2" key={kind}>
              <div className="min-w-0 flex-1 break-words"><NoticeContent message={`${recoveryCopy[kind]} ${listenerErrors[kind] ?? ''}`} language={interfaceLanguage} /></div>
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
            {historyContextLabel === null ? null : (
              <span
                className="ocr-result-status translator-history-context"
                role="status"
                title={historyContextLabel}
              >
                {t.translationHistoryContext}: {historyContextLabel}
              </span>
            )}
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
          {!loading && translationFailure !== null ? (
            <div className="ocr-result-error" role="alert">
              <p>{translationFailureSummary}</p>
              <details>
                <summary>{t.translationErrorDetails}</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words">{translationFailure.detail}</pre>
              </details>
              <button
                type="button"
                className="text-button mt-1 h-6 px-1"
                disabled={settings === null || input.trim().length === 0 || loading}
                onClick={retryTranslation}
              >
                {t.retryTranslation}
              </button>
            </div>
          ) : null}
          {(output.length > 0 || (error === null && translationFailure === null && (!loading || output.length > 0))) ? (
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
                scheduleHistoryEdit(event.target.value)
              }}
              onBlur={flushHistoryEdit}
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
