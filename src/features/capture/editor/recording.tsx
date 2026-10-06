import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureNotice } from './notice'
import { listen } from '@tauri-apps/api/event'
import type { PointerEvent } from 'react'
import type { CaptureBridge } from './bridge'
import type { CaptureScene } from './scene'
import { clamp, screenFor, type Tool } from './model'
import { CaptureIcon, ShapeButton, ToolButton, ToolPanel } from './toolbar'
import { cursorSprites } from './cursor-sprites'
import { RecordingMenu, TrimSlider } from './recording-widgets'

type State = 'ready' | 'recording' | 'paused' | 'playback'
type Status = { count: number; duration: number; bytes: number; dropped: number; state: number; timestamps: number[] }
const emptyStatus: Status = { count: 0, duration: 0, bytes: 0, dropped: 0, state: 0, timestamps: [] }
const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`
const tools: (Tool | 'shape')[] = ['pen', 'shape', 'arrow', 'text', 'eraser']
export function RecordingControls({ scene, bridge, state, setState, scale, setFrame, error, cancel }: { scene: CaptureScene; bridge: CaptureBridge; state: State; setState: (state: State) => void; scale: number; setFrame: (image: HTMLImageElement | null) => void; error: (error: string) => void; cancel: () => void }) {
  const [fps, setFps] = useState(Number(scene.snapshot.options.gif_fps ?? 10)), [status, setStatus] = useState<Status>(emptyStatus), [measuredWidth, setMeasuredWidth] = useState(570)
  const toolbar = useRef<HTMLDivElement>(null)
  const [frame, setFrameIndex] = useState(0), [start, setStart] = useState(0), [end, setEnd] = useState(0), [speed, setSpeed] = useState(1), [playing, setPlaying] = useState(false), [showCursor, setShowCursor] = useState(true), [saving, setSaving] = useState(false), [pending, setPending] = useState(false), [progress, setProgress] = useState('')
  const frameGeneration = useRef(0), running = useRef(false), active = useRef(true), exporting = useRef(false)
  const selection = scene.selection ?? scene.bounds, id = scene.snapshot.id
  const call = useCallback(async (name: string) => {
    if (running.current) return; running.current = true; setPending(true)
    try {
      scene.finishText()
      if (name === 'record_start') {
        const sprites = await cursorSprites(String(scene.snapshot.options.theme_color ?? '#3388ff'))
        await bridge.action(id, name, { rect: { ...selection, x: selection.x + scene.snapshot.bounds.x, y: selection.y + scene.snapshot.bounds.y }, value: { fps, sprites } })
        if (!active.current) return
        scene.setTool('cursor', false); setStatus(emptyStatus); setState('recording')
      } else {
        const result = await bridge.action<Status>(id, name)
        if (!active.current) return
        setStatus(result)
        if (name === 'record_pause') setState('paused')
        if (name === 'record_resume') setState('recording')
        if (name === 'record_stop') {
          scene.setTool('cursor', false)
          if (!result.count) { setState('ready'); throw new Error('没有捕获到录制画面，请重新录制或切换捕获引擎。') }
          setState('playback'); setStart(0); setEnd(result.count - 1); setFrameIndex(0); scene.onChange()
        }
      }
    } catch (e) { error(String(e)) } finally { running.current = false; if (active.current) setPending(false) }
  }, [bridge, error, fps, id, scene, selection, setState])
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { const element = toolbar.current; if (!element) return; const update = () => setMeasuredWidth(element.offsetWidth); const observer = new ResizeObserver(update); observer.observe(element); update(); return () => observer.disconnect() }, [state])
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return
    let disposed = false, pending = false
    const timer = setInterval(() => { if (pending) return; pending = true; void bridge.action<Status>(id, 'record_status').then(s => { if (!disposed) setStatus(s) }).catch((e: unknown) => { if (!disposed) error(String(e)) }).finally(() => { pending = false }) }, 250)
    return () => { disposed = true; clearInterval(timer) }
  }, [bridge, error, id, state])
  useEffect(() => {
    const generation = ++frameGeneration.current
    let disposed = false
    if (state !== 'playback' || status.count === 0) { setFrame(null); return }
    void bridge.frame(id, frame, showCursor).then(async bytes => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })), image = new Image()
      try { image.src = url; await image.decode(); if (!disposed && active.current && generation === frameGeneration.current) setFrame(image) } finally { URL.revokeObjectURL(url) }
    }).catch((e: unknown) => { if (!disposed && active.current && generation === frameGeneration.current) error(String(e)) })
    return () => { disposed = true }
  }, [bridge, error, frame, id, setFrame, showCursor, state, status.count])
  useEffect(() => {
    if (!playing || state !== 'playback') return
    const current = status.timestamps[frame] ?? frame * 1000 / fps, next = status.timestamps[frame + 1] ?? current + 1000 / fps
    const timer = setTimeout(() => setFrameIndex(value => value >= end ? start : value + 1), Math.max(10, (next - current) / speed))
    return () => clearTimeout(timer)
  }, [playing, frame, start, end, speed, state, status, fps])
  useEffect(() => {
    let stopped = false, stop: (() => void) | undefined
    void listen<{ stage: string; done: number; total: number }>('capture:export-progress', ({ payload }) => { if (!stopped) setProgress(`${payload.stage === 'compose' ? '合成' : '编码'} ${Math.round(payload.done / Math.max(1, payload.total) * 100)}%`) }).then(unlisten => { if (stopped) unlisten(); else stop = unlisten }).catch(() => { /* browser fixture has no native event channel */ })
    return () => { stopped = true; stop?.() }
  }, [])
  const save = useCallback(async (copy = false) => {
    if (exporting.current || !status.count) return
    exporting.current = true; setPlaying(false); setSaving(true); setProgress(copy ? '正在生成 GIF…' : '选择保存位置…')
    try { const result = await bridge.export(id, { format: copy ? 'gif' : 'auto', start, end, speed, width: Math.round(selection.width), height: Math.round(selection.height), showCursor, copy }); if (active.current) setProgress(result.cancelled ? '' : copy ? '已复制 GIF' : '已保存') } catch (e) { if (active.current) { setProgress(''); error(String(e)) } } finally { exporting.current = false; if (active.current) setSaving(false) }
  }, [bridge, end, error, id, selection.height, selection.width, showCursor, speed, start, status.count])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !['s', 'c'].includes(e.key.toLowerCase()) || scene.textEditing) return
      e.preventDefault(); e.stopImmediatePropagation()
      if (state === 'playback') void save(e.key.toLowerCase() === 'c')
    }
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true)
  }, [save, scene, state])
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    if (state !== 'ready' || e.button !== 0) return
    const element = e.currentTarget, x = e.clientX, y = e.clientY, initial = { ...selection }; element.setPointerCapture(e.pointerId)
    const update = (e: globalThis.PointerEvent) => {
      const nextX = clamp(initial.x + (e.clientX - x) * scene.bounds.width / window.innerWidth, 0, scene.bounds.width - initial.width), nextY = clamp(initial.y + (e.clientY - y) * scene.bounds.height / window.innerHeight, 0, scene.bounds.height - initial.height)
      const dx = nextX - (scene.selection?.x ?? nextX), dy = nextY - (scene.selection?.y ?? nextY)
      scene.selection = { ...initial, x: nextX, y: nextY }
      for (const mark of scene.marks) mark.points = mark.points.map(p => ({ x: p.x + dx, y: p.y + dy })) as typeof mark.points
      scene.onChange()
    }
    const stop = () => { element.removeEventListener('pointermove', update); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); scene.onCommit() }
    element.addEventListener('pointermove', update); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop)
  }
  const resize = (e: PointerEvent<HTMLDivElement>, edge: 'left' | 'right' | 'top' | 'bottom') => {
    if (state !== 'ready' || e.button !== 0) return
    const element = e.currentTarget, x = e.clientX, y = e.clientY, initial = { ...selection }; element.setPointerCapture(e.pointerId)
    const update = (e: globalThis.PointerEvent) => {
      const dx = (e.clientX - x) * scene.bounds.width / window.innerWidth, dy = (e.clientY - y) * scene.bounds.height / window.innerHeight
      const left = edge === 'left' ? clamp(initial.x + dx, 0, initial.x + initial.width - 2) : initial.x, top = edge === 'top' ? clamp(initial.y + dy, 0, initial.y + initial.height - 2) : initial.y
      const right = edge === 'right' ? clamp(initial.x + initial.width + dx, initial.x + 2, scene.bounds.width) : initial.x + initial.width, bottom = edge === 'bottom' ? clamp(initial.y + initial.height + dy, initial.y + 2, scene.bounds.height) : initial.y + initial.height
      scene.selection = { x: left, y: top, width: right - left, height: bottom - top }; scene.onChange()
    }
    const stop = () => { element.removeEventListener('pointermove', update); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); scene.onCommit() }
    element.addEventListener('pointermove', update); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop)
  }
  const screen = screenFor(selection, scene.snapshot.screens.map(r => ({ ...r, x: r.x - scene.snapshot.bounds.x, y: r.y - scene.snapshot.bounds.y }))) ?? scene.bounds
  const width = state === 'playback' ? Math.max(400, Math.min(660, selection.width / scale)) : measuredWidth, height = state === 'playback' ? 76 : 44, gap = 10 * scale
  const below = selection.y + selection.height + (height + 55) * scale + gap <= screen.y + screen.height
  const position = { x: clamp(selection.x + (selection.width - width * scale) / 2, screen.x, screen.x + screen.width - width * scale), y: clamp(below ? selection.y + selection.height + gap : selection.y - height * scale - gap, screen.y, screen.y + screen.height - height * scale) }
  return <>
    {state === 'ready' && scene.tool === 'cursor' && (['left', 'right', 'top', 'bottom'] as const).map(edge => <div key={edge} data-capture-interactive className="jt-record-edge" aria-label={`调整录制${{ left: '左', right: '右', top: '上', bottom: '下' }[edge]}边界`} style={{ left: edge === 'right' ? selection.x + selection.width - 4 : selection.x - 4, top: edge === 'bottom' ? selection.y + selection.height - 4 : selection.y - 4, width: edge === 'left' || edge === 'right' ? 8 : selection.width + 8, height: edge === 'top' || edge === 'bottom' ? 8 : selection.height + 8, cursor: edge === 'left' || edge === 'right' ? 'ew-resize' : 'ns-resize' }} onPointerDown={e => resize(e, edge)} />)}
    <div className="jt-record-anchor" style={{ left: position.x, top: position.y, transform: `scale(${scale})` }} data-capture-interactive>
    {state !== 'playback' ? <div className="jt-record-toolbar jt-panel" role="toolbar" aria-label="录制工具条" ref={toolbar}>
      <RecordingMenu label="录制帧率" value={fps} disabled={state !== 'ready'} options={[5, 10, 16, 24].map(v => [`${v} fps`, v])} onChange={v => { setFps(v); scene.setOption('gif_fps', v) }} />
      <button type="button" title={state === 'ready' ? '开始录制' : '结束录制'} aria-label={state === 'ready' ? '开始录制' : '结束录制'} disabled={pending} onClick={() => void call(state === 'ready' ? 'record_start' : 'record_stop')}><CaptureIcon name={state === 'ready' ? 'start' : 'stop'} /></button>
      <button type="button" title={state === 'paused' ? '继续录制' : '暂停录制'} aria-label={state === 'paused' ? '继续录制' : '暂停录制'} disabled={state === 'ready' || pending} onClick={() => void call(state === 'paused' ? 'record_resume' : 'record_pause')}><CaptureIcon name={state === 'paused' ? '重开录制' : 'pause'} /></button>
      <span className={`jt-record-time ${state === 'recording' ? 'recording' : ''}`}>{time(status.duration)}</span>
      <span className="jt-separator" />{tools.map(tool => tool === 'shape' ? <ShapeButton key={tool} scene={scene} below={below} /> : <ToolButton key={tool} name={tool} active={scene.tool === tool} onClick={() => scene.setTool(tool)} />)}
      <span className="jt-separator" /><ToolButton name="undo" disabled={!scene.history.canUndo} onClick={() => scene.undo()} /><ToolButton name="redo" disabled={!scene.history.canRedo} onClick={() => scene.redo()} />
      <button type="button" className="jt-record-move" aria-label="移动录制区域" title={state === 'ready' ? '移动录制区域' : '录制中无法移动'} disabled={state !== 'ready'} onPointerDown={move}><CaptureIcon name="移动窗口" /></button>
      <button type="button" title="关闭录制" aria-label="关闭录制" onClick={cancel}><CaptureIcon name="关闭" /></button>
    </div> : <div className="jt-playback jt-panel" style={{ width }} role="group" aria-label="录制回放">
      <TrimSlider total={status.count} start={start} end={end} frame={frame} disabled={saving} onSeek={v => { setPlaying(false); setFrameIndex(v) }} onTrim={(a, b) => { setPlaying(false); setStart(a); setEnd(b); setFrameIndex(v => clamp(v, a, b)) }} />
      <div className="jt-playback-row">
        <button type="button" aria-label={playing ? '暂停回放' : '播放'} title={playing ? '暂停回放' : '播放'} disabled={!status.count || saving} onClick={() => { if (frame < start || frame > end) setFrameIndex(start); setPlaying(v => !v) }}><CaptureIcon name={playing ? 'pause' : '重开录制'} /></button>
        <span className="jt-playback-time">{time(status.timestamps[frame] ?? frame * 1000 / fps)} / {time(status.duration)}</span>
        <RecordingMenu label="播放速度" value={speed} disabled={saving} options={[0.5, 0.75, 1, 1.25, 1.5, 2].map(v => [`${v === 1 || v === 2 ? v.toFixed(1) : v}x`, v])} onChange={setSpeed} />
        <span className="jt-playback-spacer" />
        <button type="button" aria-label="重新录制" title="重新录制" disabled={saving} onClick={() => { setPlaying(false); setState('ready'); setFrame(null); setStatus(emptyStatus); setProgress('') }}><CaptureIcon name="restart" /></button>
        <button type="button" aria-label="显示鼠标光标" title="显示鼠标光标" aria-pressed={showCursor} disabled={saving} onClick={() => setShowCursor(v => !v)}><CaptureIcon name="mouse" /></button>
        <button type="button" aria-label="复制 GIF" title="复制到剪贴板" disabled={!status.count || saving} onClick={() => void save(true)}><CaptureIcon name="复制" /></button>
        <button type="button" aria-label="另存为" title="另存为 GIF / MP4" disabled={!status.count || saving} onClick={() => void save()}><CaptureIcon name="保存" /></button>
        <button type="button" aria-label="关闭回放" title="关闭" disabled={saving} onClick={cancel}><CaptureIcon name="关闭" /></button>
      </div>
      {(saving || progress) && <CaptureNotice snapshot={scene.snapshot} message={progress || '正在导出…'} onDismiss={saving ? undefined : () => setProgress('')}>{saving && <button type="button" onClick={() => void bridge.cancelExport(id).catch((e: unknown) => error(String(e)))}>取消导出</button>}</CaptureNotice>}
      {!!status.dropped && <small>录制丢帧 {status.dropped} 帧</small>}
    </div>}
    {state !== 'playback' && scene.tool !== 'cursor' && <div className={`jt-panel-anchor ${below ? 'below' : 'above'}`}><ToolPanel scene={scene} /></div>}
  </div></>
}
