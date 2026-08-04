import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Clock3, Trash2, X } from 'lucide-react'

export type HistoryMenuItem = {
  id: string
  input: string
  output: string
  updatedAt: number
  method?: string
}

export type HistoryMenuProps<T extends HistoryMenuItem = HistoryMenuItem> = {
  items: readonly T[]
  title: string
  countAnnouncementId: string
  showOutput?: boolean
  getMeta?: (item: T) => string | undefined
  onRestore: (item: T) => void
  onRemove: (id: string) => void
  onClear: () => void
}

const HISTORY_MENU_WIDTH = 340

function formatRelativeTime(updatedAt: number): string {
  const minutes = Math.floor((Date.now() - updatedAt) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function HistoryMenu<T extends HistoryMenuItem>({
  items,
  title,
  countAnnouncementId,
  showOutput = true,
  getMeta,
  onRestore,
  onRemove,
  onClear,
}: HistoryMenuProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: -9999, left: -9999 })

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const edge = 8
      const left = Math.max(edge, Math.min(rect.right - HISTORY_MENU_WIDTH, window.innerWidth - HISTORY_MENU_WIDTH - edge))
      setPosition({ top: rect.bottom + 6, left })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.blur()
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className="history-menu-root">
      <button
        type="button"
        ref={triggerRef}
        className={`ocr-header-button history-button${items.length > 0 ? ` history-button-count-${String(items.length).length}` : ''}`}
        title={title}
        aria-label={title}
        aria-describedby={countAnnouncementId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-tauri-drag-region="false"
      >
        <Clock3 size={16} />
        {items.length > 0 ? (
          <span className="history-count-badge" aria-hidden="true">
            {items.length}
          </span>
        ) : null}
        <span id={countAnnouncementId} className="history-count-announcement">
          {items.length > 0 ? `历史记录：${items.length} 条` : '暂无历史记录'}
        </span>
      </button>

      {open ? createPortal(
        <div
          ref={popoverRef}
          className="history-menu-popover"
          role="complementary"
          aria-label={title}
          style={{ top: position.top, left: position.left }}
        >
          {items.length === 0 ? (
            <div className="history-menu-empty">暂无历史记录</div>
          ) : (
            <>
              <div className="history-menu-list custom-scrollbar">
                {items.map((item) => (
                  <div key={item.id} className="history-menu-item group/item">
                    <button
                      type="button"
                      className="history-menu-restore"
                      title={item.input}
                      onClick={() => {
                        onRestore(item)
                        setOpen(false)
                      }}
                      data-tauri-drag-region="false"
                    >
                      <span className="history-menu-input">{item.input}</span>
                      {showOutput ? <span className="history-menu-output">{item.output}</span> : null}
                      <span className="history-menu-meta" aria-hidden="true">
                        {(getMeta?.(item) ?? item.method) ? `${getMeta?.(item) ?? item.method} · ` : ''}
                        {formatRelativeTime(item.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="history-menu-delete"
                      aria-label="删除历史"
                      title="删除历史"
                      onClick={() => onRemove(item.id)}
                      data-tauri-drag-region="false"
                    >
                      <X size={11} strokeWidth={2.25} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="history-menu-footer">
                <button
                  type="button"
                  className="history-menu-clear"
                  onClick={() => {
                    onClear()
                    setOpen(false)
                  }}
                  data-tauri-drag-region="false"
                >
                  <Trash2 size={11} />
                  清空
                </button>
              </div>
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
