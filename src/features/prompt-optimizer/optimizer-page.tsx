import { Check, Clipboard, Replace, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDesktop } from '../../desktop/use-desktop'
import { useSplitRatio } from '../../shared/hooks/use-split-ratio'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'
import { HistoryMenu } from '../history/history-menu'
import { copyFor } from '../../shared/ui-copy'
import type { InterfaceLanguage } from '../settings/types'
import { syncDocumentTheme } from '../../shared/theme'

type OptimizerHistory = {
  id: string
  input: string
  output: string
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
  const [interfaceLanguage, setInterfaceLanguage] = useState<InterfaceLanguage>(() =>
    document.documentElement.lang.startsWith('en') ? 'en' : 'zh',
  )
  const [history, setHistory] = useState(() => loadHistory(localStorage, historyKey, validHistory))
  const generation = useRef(0)
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
    if ('__TAURI_INTERNALS__' in window) void getCurrentWindow().setTitle(document.title)
  }, [interfaceLanguage, t.optimizerTitle])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void desktop.hideWindow()
    }
    window.addEventListener('keydown', handleEscape)
    return () => {
      generation.current += 1
      window.removeEventListener('keydown', handleEscape)
    }
  }, [desktop])

  const updateInput = (value: string) => {
    if (value === input) return
    generation.current += 1
    setInput(value)
    setOutput('')
    setLoading(false)
    setError(null)
    setCopied(false)
  }

  const optimize = async () => {
    const source = input
    if (source.trim().length === 0 || loading) return
    const requestGeneration = generation.current + 1
    generation.current = requestGeneration
    setLoading(true)
    setError(null)
    setOutput('')
    setCopied(false)
    try {
      const result = await desktop.optimizePrompt({ text: source, generation: requestGeneration })
      if (result.generation !== generation.current) return
      setOutput(result.text)
      const entry = { id: crypto.randomUUID(), input: source, output: result.text, updatedAt: Date.now() }
      setHistory((items) => saveHistory(localStorage, historyKey, upsertHistory(items, entry)))
    } catch (reason) {
      if (requestGeneration === generation.current) setError(String(reason))
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
    }
  }

  const restoreHistory = (item: OptimizerHistory) => {
    generation.current += 1
    setInput(item.input)
    setOutput(item.output)
    setLoading(false)
    setError(null)
    setCopied(false)
    queueMicrotask(() => document.getElementById('optimizer-input')?.focus())
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
          {loading ? t.optimizing : input.trim().length > 0 ? t.optimizeShortcut : t.waitingForInput}
        </span>
        <div className="ocr-result-header-actions">
          <HistoryMenu
            items={history}
            title={t.optimizationHistory}
            countAnnouncementId="optimizer-history-count"
            language={interfaceLanguage}
            showOutput={false}
            onRestore={restoreHistory}
            onRemove={(id) => setHistory((items) => saveHistory(localStorage, historyKey, items.filter((entry) => entry.id !== id)))}
            onClear={() => setHistory((items) => saveHistory(localStorage, historyKey, items.length === 0 ? items : []))}
          />
          <button type="button" className="ocr-header-button" aria-label={t.closeOptimizer} onClick={() => void desktop.hideWindow()}><X size={14} /></button>
        </div>
      </header>
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
              <button type="button" className="ocr-section-button" aria-label={t.copyOptimizationResult} disabled={output.length === 0} onClick={() => void navigator.clipboard.writeText(output).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) })}>{copied ? <Check size={12} /> : <Clipboard size={12} />}</button>
            </div>
          </div>
          {loading ? <div className="ocr-result-skeleton"><span /><span /><span /></div> : null}
          {!loading && error !== null ? <div className="ocr-result-error" role="alert">{error}<button type="button" className="text-button" onClick={() => void optimize()}>{t.retry}</button></div> : null}
          {!loading && error === null ? <textarea id="optimizer-output" value={output} placeholder={t.optimizationResultPlaceholder} onChange={(event) => setOutput(event.target.value)} /> : null}
        </section>
      </div>
    </main>
  )
}
