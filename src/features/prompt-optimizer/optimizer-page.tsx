import { Check, Clipboard, Clock3, Replace, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDesktop } from '../../desktop/use-desktop'
import { useSplitRatio } from '../../shared/hooks/use-split-ratio'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { loadHistory, saveHistory, upsertHistory } from '../history/storage'

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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState(() => loadHistory(localStorage, historyKey, validHistory))
  const generation = useRef(0)
  const composing = useRef(false)
  const { ratio, beginResize } = useSplitRatio(splitRatioKey, goldenSectionRatio)
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

  const optimize = async () => {
    if (input.trim().length === 0 || loading) return
    const requestGeneration = generation.current + 1
    generation.current = requestGeneration
    setLoading(true)
    setError(null)
    try {
      const result = await desktop.optimizePrompt({ text: input, generation: requestGeneration })
      if (result.generation !== generation.current) return
      setOutput(result.text)
      const entry = { id: crypto.randomUUID(), input, output: result.text, updatedAt: Date.now() }
      setHistory((items) => saveHistory(localStorage, historyKey, upsertHistory(items, entry)))
    } catch (reason) {
      if (requestGeneration === generation.current) setError(String(reason))
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
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
          <h1>提示词优化</h1>
        </div>
        <span className="ocr-result-status" aria-live="polite">
          {loading ? '优化中…' : input.trim().length > 0 ? 'Ctrl+Enter 优化' : '等待输入'}
        </span>
        <div className="ocr-result-header-actions">
          <button
            type="button"
            className="ocr-header-button history-button"
            aria-label="优化历史"
            aria-describedby="optimizer-history-count"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <Clock3 size={16} />
            {history.length > 0 ? <span className="history-count-badge" aria-hidden="true">{history.length}</span> : null}
            <span id="optimizer-history-count" className="history-count-announcement">
              {history.length > 0 ? `历史记录：${history.length} 条` : '暂无历史记录'}
            </span>
          </button>
          <button type="button" className="ocr-header-button" aria-label="关闭优化器" onClick={() => void desktop.hideWindow()}><X size={14} /></button>
        </div>
      </header>
      <div
        className="ocr-result-body translator-split-body"
        style={{ gridTemplateRows: `${String(ratio)}fr 9px ${String(1 - ratio)}fr` }}
      >
        <section className="ocr-result-section ocr-result-source">
          <div className="ocr-result-section-heading">
            <label htmlFor="optimizer-input">原始提示词</label>
            <button
              type="button"
              className="ocr-compact-action"
              disabled={loading || input.trim().length === 0}
              onClick={() => void optimize()}
            >
              <Sparkles size={13} />{loading ? '优化中…' : '优化'}
            </button>
          </div>
          <textarea
            id="optimizer-input"
            value={input}
            placeholder="输入需要优化的提示词"
            autoFocus
            onChange={(event) => setInput(event.target.value)}
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
          aria-label="调整原始提示词和优化结果高度"
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
            <label htmlFor="optimizer-output">优化结果</label>
            <div className="optimizer-result-actions">
              <button type="button" className="ocr-section-button" aria-label="替换原文" disabled={output.length === 0} onClick={() => { setInput(output); setOutput('') }}><Replace size={12} /></button>
              <button type="button" className="ocr-section-button" aria-label="复制优化结果" disabled={output.length === 0} onClick={() => void navigator.clipboard.writeText(output).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) })}>{copied ? <Check size={12} /> : <Clipboard size={12} />}</button>
            </div>
          </div>
          {loading ? <div className="ocr-result-skeleton"><span /><span /><span /></div> : null}
          {!loading && error !== null ? <div className="ocr-result-error" role="alert">{error}<button type="button" className="text-button" onClick={() => void optimize()}>重试</button></div> : null}
          {!loading && error === null ? <textarea id="optimizer-output" value={output} placeholder="优化结果可在此编辑" onChange={(event) => setOutput(event.target.value)} /> : null}
        </section>
      </div>
      {historyOpen ? (
        <aside className="history-popover ocr-history-popover" aria-label="优化历史">
          <header><strong>最近优化</strong><button type="button" className="text-button" onClick={() => { setHistory([]); saveHistory(localStorage, historyKey, []) }}>清空</button></header>
          <div>{history.length === 0 ? <p>暂无历史</p> : history.map((item) => (
            <article key={item.id}>
              <button type="button" onClick={() => { setInput(item.input); setOutput(item.output); setHistoryOpen(false) }}><strong>{item.input}</strong><span>{item.output}</span></button>
              <button type="button" className="icon-button" aria-label="删除历史" onClick={() => setHistory((items) => saveHistory(localStorage, historyKey, items.filter((entry) => entry.id !== item.id)))}><Trash2 size={13} /></button>
            </article>
          ))}</div>
        </aside>
      ) : null}
    </main>
  )
}
