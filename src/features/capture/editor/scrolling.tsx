import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Download } from 'lucide-react'
import { CaptureIcon } from './toolbar'
import { clamp, screenFor, type Point } from './model'
import { previewInset, scrollPreviewRect, scrollPreviewViewport } from './scroll-preview'
import type { CaptureScene } from './scene'
import type { CaptureBridge } from './bridge'
type Step = { width: number; height: number; count: number; changed: boolean; noOverlap: boolean; preview: string }
export function ScrollControls({ scene, bridge, scale, cancel, finish, error }: { scene: CaptureScene; bridge: CaptureBridge; scale: number; cancel: () => void; finish: (pin: boolean, save?: boolean) => Promise<void>; error: (error: string) => void }) {
  const region = scene.selection ?? scene.bounds, bounds = scene.bounds, id = scene.snapshot.id
  const [horizontal, setHorizontal] = useState(false), [preview, setPreview] = useState<Step | null>(null), [manual, setManual] = useState<Point | null>(null), [pending, setPending] = useState(false)
  const screens = scene.snapshot.screens.map(r => ({ ...r, x: r.x - scene.snapshot.bounds.x, y: r.y - scene.snapshot.bounds.y }))
  const screen = screenFor(region, screens) ?? bounds
  const viewport = scrollPreviewViewport(region, screen, horizontal, scale)
  const previewWidth = Math.max(1, Math.round(viewport.width - previewInset * 2)), previewHeight = Math.max(1, Math.round(viewport.height - previewInset * 2))
  const busy = useRef<Promise<void> | null>(null), alive = useRef(true), finishing = useRef(false), changingDirection = useRef(false)
  const step = useCallback(async (poll = false) => {
    if (busy.current || finishing.current || changingDirection.current) return
    const task = (async () => {
      try { const value = await bridge.action<Step | null>(id, poll ? 'scroll_poll' : 'scroll_step', { value: { width: previewWidth, height: previewHeight } }); if (alive.current && value) setPreview(value) } catch (e) { if (alive.current) error(String(e)) }
    })()
    busy.current = task
    try { await task } finally { busy.current = null }
  }, [bridge, error, id, previewWidth, previewHeight])
  useEffect(() => { alive.current = true; const timer = setInterval(() => void step(true), 100); return () => { alive.current = false; clearInterval(timer) } }, [step])
  useEffect(() => { let disposed = false; void bridge.action<Step>(id, 'scroll_preview', { value: { width: previewWidth, height: previewHeight } }).then(value => { if (!disposed) setPreview(current => current ?? value) }).catch((e: unknown) => { if (!disposed) error(String(e)) }); return () => { disposed = true } }, [bridge, id, error, previewWidth, previewHeight])
  const width = 332 * scale, height = 40 * scale, margin = 10 * scale
  const centered = clamp(region.x + (region.width - width) / 2, margin, bounds.width - width - margin)
  const at = manual ?? (region.y >= height + margin * 2 ? { x: centered, y: region.y - height - margin } : region.y + region.height + height + margin * 2 <= bounds.height ? { x: centered, y: region.y + region.height + margin } : { x: clamp(region.x + region.width + margin, margin, bounds.width - width - margin), y: clamp(region.y + (region.height - height) / 2, margin, bounds.height - height - margin) })
  const imageWidth = preview?.width ?? region.width, imageHeight = preview?.height ?? region.height
  const previewAt = scrollPreviewRect(region, screen, { width: imageWidth, height: imageHeight }, horizontal, scale)
  const stop = async (pin: boolean, save = false) => {
    if (finishing.current) return
    finishing.current = true; setPending(true)
    try { await busy.current; if (alive.current) await finish(pin, save) }
    finally { finishing.current = false; if (alive.current) setPending(false) }
  }
  return <>
    <div className="jt-scroll-controls jt-panel" role="toolbar" aria-label="长截图工具条" data-capture-interactive style={{ left: at.x, top: at.y, transform: `scale(${scale})` }}>
      <div className="jt-grip" title="拖动；双击恢复位置" onDoubleClick={() => setManual(null)} onPointerDown={e => {
        const element = e.currentTarget, start = { x: e.clientX, y: e.clientY }; element.setPointerCapture(e.pointerId)
        const move = (e: globalThis.PointerEvent) => setManual({ x: clamp(at.x + (e.clientX - start.x) * bounds.width / window.innerWidth, 0, bounds.width - width), y: clamp(at.y + (e.clientY - start.y) * bounds.height / window.innerHeight, 0, bounds.height - height) })
        const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up) }
        element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up)
      }}>⋮</div>
      <button type="button" className="jt-scroll-direction" aria-label="切换拼接方向" disabled={pending} onClick={() => { const next = !horizontal; changingDirection.current = true; setPending(true); void (async () => { await busy.current; await bridge.action(id, 'scroll_direction', { value: next }); setPreview(null); setHorizontal(next) })().catch((e: unknown) => error(String(e))).finally(() => { changingDirection.current = false; setPending(false) }) }}>{horizontal ? '↔ 横向' : '↕ 竖向'}</button>
      <button type="button" title="手动截图" aria-label="手动截图" disabled={pending} onClick={() => void step()}><CaptureIcon name="托盘" /></button>
      <button type="button" title="钉图" aria-label="钉住长截图" disabled={pending} onClick={() => void stop(true)}><CaptureIcon name="pin" /></button>
      <button type="button" title="保存到文件 Ctrl+S" aria-label="保存长截图" disabled={pending} onClick={() => void stop(false, true)}><Download size={22} strokeWidth={1.8} aria-hidden="true" /></button>
      <button type="button" title="完成并复制" aria-label="完成长截图" disabled={pending} onClick={() => void stop(false)}><Copy size={22} strokeWidth={1.8} aria-hidden="true" /></button>
      <button type="button" title="取消" aria-label="取消长截图" onClick={cancel}><CaptureIcon name="cancel" /></button>
    </div>
    <div className="jt-scroll-preview" data-capture-visible role="region" aria-label="长截图实时预览" style={{ left: previewAt.x, top: previewAt.y, width: previewAt.width, height: previewAt.height }}>
      {preview && <img alt="长截图实时预览" src={preview.preview} />}<b>{preview?.count ?? 1}</b>{preview?.noOverlap && <i title="未找到重叠区域，请缓慢滚动">!</i>}
      <span>{imageWidth} × {imageHeight}</span>
    </div>
  </>
}
