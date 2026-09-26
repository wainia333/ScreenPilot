import { Check, Clipboard, Replace, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDesktop } from '../../desktop/use-desktop'
import { useSplitRatio } from '../../shared/hooks/use-split-ratio'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'
import { HistoryMenu } from '../history/history-menu'
import { copyFor } from '../../shared/ui-copy'
import type { InterfaceLanguage } from '../settings/types'
import { syncDocumentTheme } from '../../shared/theme'
import { nextOptimizerGeneration } from './optimizer-generation'

type OptimizerHistory = {
  id: string
  input: string
  output: string
  originalOutput?: string
  updatedAt: number
}

const historyKey = 'screenpilot:optimizer-history'
const goldenSectionRatio = (3 - Math.sqrt(5)) / 2
const splitRatioKey = 'screenpilot:optimizer-golden-split-v2'

function validHistory(value: unknown): value is OptimizerHistory {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<OptimizerHistory>
  return typeof item.id === 'string' && typeof item.input === 'string' && typeof item.output === 'string' && typeof item.updatedAt === 'number'
}

export function OptimizerPage() {
  const desktop = useDesktop()
  const beginWindowDrag = useWindowDrag()
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [interfaceLanguage, setInterfaceLanguage] = useState<InterfaceLanguage>(() =>
    document.documentElement.lang.startsWith('en') ? 'en' : 'zh',
  )
  const [history, setHistory] = useState(() => loadHistory(localStorage, historyKey, validHistory))
  const historyRef = useRef(history)
  const persistedHistoryRef = useRef(history)
  const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const activeHistoryId = useRef<string | null>(null)
  const historyEditTimer = useRef<number | null>(null)
  const pendingHistoryEdit = useRef<{ id: string; output: string } | null>(null)
  useEffect(() => {
    historyRef.current = history
  }, [history])
  const persistHistory = useCallback((next: OptimizerHistory[]) => {
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
    const id = activeHistoryId.current
    if (id === null) return
    pendingHistoryEdit.current = { id, output }
    if (historyEditTimer.current !== null) window.clearTimeout(historyEditTimer.current)
    historyEditTimer.current = window.setTimeout(() => {
      historyEditTimer.current = null
      flushHistoryEdit()
    }, 300)
  }, [flushHistoryEdit])
  const generation = useRef(0)
  const requestActive = useRef(false)
  const copyRequest = useRef(0)
  const composing = useRef(false)
  const { ratio, beginResize, resizeByKeyboard } = useSplitRatio(splitRatioKey, goldenSectionRatio)
  const t = copyFor(interfaceLanguage)
  useEffect(() => {
    let active = true
    void desktop.loadSettings().then((settings) => {
      if (active) {
        syncDocumentTheme(settings.theme)
        setInterfaceLanguage(settings.language)
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [desktop])
  useEffect(() => {
    document.documentElement.lang = interfaceLanguage === 'zh' ? 'zh-CN' : 'en'
    document.title = `ScreenPilot — ${t.optimizerTitle}`
    if ('__TAURI_INTERNALS__' in window) {
      void getCurrentWindow().setTitle(document.title).catch((reason: unknown) => {
        console.error('[optimizer] failed to set window title', reason)
      })
    }
  }, [interfaceLanguage, t.optimizerTitle])
  const invalidateOptimization = useCallback(() => {
    const invalidationGeneration = nextOptimizerGeneration()
    generation.current = invalidationGeneration
    const shouldCancelBackend = requestActive.current
    requestActive.current = false
    if (!shouldCancelBackend) return Promise.resolve()
    return desktop.cancelPromptOptimization(invalidationGeneration).then(() => undefined).catch((reason: unknown) => {
      console.error('[optimizer] failed to cancel active optimization', reason)
    })
  }, [desktop])
  const hideOptimizer = useCallback(async () => {
    flushHistoryEdit()
    const cancellation = invalidateOptimization()
    try {
      await desktop.hideWindow()
    } catch (reason) {
      setLoading(false)
      setError(String(reason))
    }
    await cancellation
  }, [desktop, flushHistoryEdit, invalidateOptimization])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void hideOptimizer()
    }
    window.addEventListener('keydown', handleEscape)
    return () => {
      flushHistoryEdit()
      void invalidateOptimization()
      copyRequest.current += 1
      window.removeEventListener('keydown', handleEscape)
    }
  }, [flushHistoryEdit, hideOptimizer, invalidateOptimization])

  const updateInput = (value: string) => {
    if (value === input) return
    flushHistoryEdit()
    activeHistoryId.current = null
    void invalidateOptimization()
    setInput(value)
    setOutput('')
    setLoading(false)
    setError(null)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
  }

  const optimize = async () => {
    const source = input
    if (source.trim().length === 0 || loading) return
    const requestGeneration = nextOptimizerGeneration()
    generation.current = requestGeneration
    requestActive.current = true
    setLoading(true)
    setError(null)
    setOutput('')
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    try {
      const result = await desktop.optimizePrompt({ text: source, generation: requestGeneration })
      if (result.generation !== generation.current) return
      setOutput(result.text)
      const entry = {
        id: crypto.randomUUID(),
        input: source,
        output: result.text,
        originalOutput: result.text,
        updatedAt: Date.now(),
      }
      activeHistoryId.current = entry.id
      persistHistory(upsertHistory(historyRef.current, entry))
    } catch (reason) {
      if (requestGeneration === generation.current) setError(String(reason))
    } finally {
      if (requestGeneration === generation.current) {
        requestActive.current = false
        setLoading(false)
      }
    }
  }

  const restoreHistory = (item: OptimizerHistory) => {
    flushHistoryEdit()
    void invalidateOptimization()
    const current = historyRef.current.find((entry) => entry.id === item.id) ?? item
    activeHistoryId.current = current.id
    setInput(current.input)
    setOutput(current.output)
    setLoading(false)
    setError(null)
    copyRequest.current += 1
    setCopied(false)
    setCopyError(null)
    queueMicrotask(() => document.getElementById('optimizer-input')?.focus())
  }

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
      className="translator-window ocr-result-card optimizer-window screenpilot-jelly-pop"
      data-screenpilot-window-frame="true"
      data-screenpilot-ocr-card="true"
    >
      <header className="ocr-result-header" onPointerDown={beginWindowDrag}>
        <div className="ocr-result-identity">
          <span className="ocr-result-mark"><Sparkles size={15} /></span>
          <h1>{t.optimizerTitle}</h1>
        </div>
        <span className="ocr-result-status" aria-live="polite">
          {copyError ?? (loading ? t.optimizing : input.trim().length > 0 ? t.optimizeShortcut : t.waitingForInput)}
        </span>
        <div className="ocr-result-header-actions">
          <HistoryMenu
            items={history}
            title={t.optimizationHistory}
            countAnnouncementId="optimizer-history-count"
            language={interfaceLanguage}
            showOutput={false}
            onRestore={restoreHistory}
            onRemove={(id) => persistHistory(historyRef.current.filter((entry) => entry.id !== id))}
            onClear={() => persistHistory(historyRef.current.length === 0 ? historyRef.current : [])}
          />
          <button type="button" className="ocr-header-button" aria-label={t.closeOptimizer} onClick={() => void hideOptimizer()}><X size={14} /></button>
        </div>
      </header>
      {historySaveFailed ? (
        <aside className="mx-3 mt-2 shrink-0 rounded-lg bg-white/95 px-3 py-2 text-[11px] text-red-600 shadow-md ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-red-400 dark:ring-white/10" role="alert">
          <span>{t.historyNotSaved}</span>
          <button type="button" className="text-button ml-2 h-6 px-1" onClick={retryHistorySave}>{t.retryHistory}</button>
        </aside>
      ) : null}
      <div
        className="ocr-result-body translator-split-body"
        style={{ gridTemplateRows: `${String(ratio)}fr 9px ${String(1 - ratio)}fr` }}
      >
        <section className="ocr-result-section ocr-result-source">
          <div className="ocr-result-section-heading">
            <label htmlFor="optimizer-input">{t.originalPrompt}</label>
            <button
              type="button"
              className="ocr-compact-action"
              disabled={loading || input.trim().length === 0}
              onClick={() => void optimize()}
            >
              <Sparkles size={13} />{loading ? t.optimizing : t.optimize}
            </button>
          </div>
          <textarea
            id="optimizer-input"
            value={input}
            placeholder={t.optimizerInputPlaceholder}
            autoFocus
            onChange={(event) => updateInput(event.target.value)}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !composing.current) {
                event.preventDefault()
                void optimize()
              }
            }}
          />
        </section>
        <button
          type="button"
          role="separator"
          className="ocr-result-divider translator-split-divider"
          aria-label={t.resizeOptimizerPanels}
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
            <label htmlFor="optimizer-output">{t.optimizationResult}</label>
            <div className="optimizer-result-actions">
              <button type="button" className="ocr-section-button" aria-label={t.replaceOriginal} disabled={output.length === 0} onClick={() => updateInput(output)}><Replace size={12} /></button>
              <button type="button" className="ocr-section-button" aria-label={t.copyOptimizationResult} disabled={output.length === 0} onClick={() => void copyOutput()}>{copied ? <Check size={12} /> : <Clipboard size={12} />}</button>
            </div>
          </div>
          {loading ? <div className="ocr-result-skeleton"><span /><span /><span /></div> : null}
          {!loading && error !== null ? <div className="ocr-result-error" role="alert">{error}<button type="button" className="text-button" onClick={() => void optimize()}>{t.retry}</button></div> : null}
          {!loading && error === null ? (
            <textarea
              id="optimizer-output"
              value={output}
              placeholder={t.optimizationResultPlaceholder}
              onChange={(event) => {
                copyRequest.current += 1
                setOutput(event.target.value)
                setCopied(false)
                setCopyError(null)
                scheduleHistoryEdit(event.target.value)
              }}
              onBlur={flushHistoryEdit}
            />
          ) : null}
        </section>
      </div>
    </main>
  )
}
