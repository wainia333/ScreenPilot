import { isTauriRuntime } from '../desktop/runtime'

export function BrowserPreviewBadge() {
  if (isTauriRuntime()) return null

  return (
    <div
      className="browser-preview-badge"
      data-screenpilot-browser-preview="true"
      role="status"
      aria-label="浏览器预览 Demo；原生功能不可用"
    >
      <span aria-hidden="true">Demo</span>
      <span>浏览器预览</span>
    </div>
  )
}
