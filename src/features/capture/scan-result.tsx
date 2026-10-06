import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, QrCode, ScanLine, X } from 'lucide-react'
import { useDesktop } from '../../desktop/use-desktop'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { syncDocumentTheme } from '../../shared/theme'
import { TopNotice } from '../../shared/ui/top-notice'
import { captureBridge, type CaptureBridge } from './editor/bridge'
import type { CaptureSnapshot } from './editor/model'
import { scanTextParts } from './scan-links'
import './scan-result.css'

export function ScanResultSurface({ snapshot, bridge = captureBridge, visible = true }: { snapshot: CaptureSnapshot; bridge?: CaptureBridge; visible?: boolean }) {
  const beginDrag = useWindowDrag()
  const [error, setError] = useState(''), [copied, setCopied] = useState<number | null>(null), [dismissed, setDismissed] = useState(false)
  const closing = useRef(false)
  const results = snapshot.scanResults
  const notice = error ? error : dismissed ? null : snapshot.scanError ?? null
  const close = useCallback(() => {
    if (closing.current) return
    closing.current = true
    void bridge.action(snapshot.id, 'cancel').catch((e: unknown) => { closing.current = false; setError(String(e)) })
  }, [bridge, snapshot.id])
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [close])
  const open = (href: string) => void bridge.action(snapshot.id, 'open_link', { value: href }).catch((e: unknown) => setError(String(e)))
  return <>
    <main className={`ocr-result-card scan-result-window${visible ? ' screenpilot-jelly-pop' : ''}`} style={{ visibility: visible ? undefined : 'hidden' }} data-screenpilot-window-frame="true" role="dialog" aria-label="扫码结果">
      <header className="ocr-result-header" onPointerDown={beginDrag}>
        <div className="ocr-result-identity"><span className="ocr-result-mark"><QrCode size={15} /></span><h1>扫码结果</h1></div>
        <span className="ocr-result-status" aria-live="polite">{copied !== null ? '已复制' : results == null ? '正在识别…' : `${results.length} 个结果`}</span>
        <div className="ocr-result-header-actions"><button className="ocr-header-button" type="button" aria-label="关闭扫码结果" onClick={close}><X size={14} /></button></div>
      </header>
      <div className="ocr-result-body scan-result-list">
        {results == null ? <div className="scan-result-empty" role="status"><ScanLine size={30} /><p>正在识别二维码和条形码…</p></div>
          : results.length ? results.map((code, index) => <section className="ocr-result-section scan-result-entry" key={`${index}-${code.format}`}>
            <div className="ocr-result-section-heading"><span>{code.format || '二维码'}{results.length > 1 ? ` · ${index + 1}` : ''}</span><button type="button" className="ocr-section-button" aria-label={`复制结果 ${index + 1}`} title="复制内容" onClick={() => { void bridge.action(snapshot.id, 'copy_text', { value: code.text }).then(() => setCopied(index)).catch((e: unknown) => setError(String(e))) }}><Copy size={14} /></button></div>
            <div className="result-text scan-result-text" aria-label={`识别结果 ${index + 1}`} tabIndex={0}>{scanTextParts(code.text).map((part, i) => part.href ? <a key={i} href={part.href} onClick={e => { e.preventDefault(); open(part.href ?? '') }} onAuxClick={e => { if (e.button === 1) { e.preventDefault(); open(part.href ?? '') } }}>{part.text}</a> : <span key={i}>{part.text}</span>)}</div>
          </section>) : <div className="scan-result-empty"><QrCode size={30} /><p>没有识别到二维码或条形码。</p><button type="button" className="secondary-button" onClick={() => void bridge.action(snapshot.id, 'scan_again').catch((e: unknown) => setError(String(e)))}>重新扫码</button></div>}
      </div>
    </main>
    {notice && <TopNotice portal tone="error" message={notice} onDismiss={() => { setError(''); setDismissed(true) }} />}
  </>
}

export function ScanResultRoot() {
  const desktop = useDesktop()
  const [snapshot, setSnapshot] = useState<CaptureSnapshot | null>(null), [visible, setVisible] = useState(false), [error, setError] = useState('')
  const readyId = useRef('')
  const id = snapshot?.id
  useEffect(() => {
    let disposed = false, generation = 0, stop: (() => void) | undefined
    const load = async () => {
      const token = ++generation
      try {
        const next = await captureBridge.snapshot()
        if (disposed || token !== generation) return
        setSnapshot(next)
      } catch (e) { if (!disposed) setError(String(e)) }
    }
    void desktop.loadSettings().then(settings => { if (!disposed) syncDocumentTheme(settings.theme) }).catch((e: unknown) => { if (!disposed) setError(String(e)) })
    void captureBridge.session(() => void load()).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; void load() } }).catch((e: unknown) => { if (!disposed) setError(String(e)) })
    return () => { disposed = true; stop?.() }
  }, [desktop])
  useEffect(() => {
    if (!id || readyId.current === id) return
    let disposed = false
    void captureBridge.ready(id).then(() => { if (!disposed) { readyId.current = id; setVisible(true) } }).catch((e: unknown) => { if (!disposed) setError(String(e)) })
    return () => { disposed = true }
  }, [id])
  return <>{snapshot && <ScanResultSurface snapshot={snapshot} visible={visible} />}{error && <TopNotice portal tone="error" message={error} onDismiss={() => setError('')} />}</>
}
