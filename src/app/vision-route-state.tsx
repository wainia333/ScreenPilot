import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useDesktop } from '../desktop/use-desktop'

function interfaceCopy() {
  const english = document.documentElement.lang.startsWith('en')
  return english
    ? {
        loading: 'Loading Vision…',
        failed: 'Vision failed to load',
        retry: 'Retry',
        close: 'Close',
      }
    : {
        loading: '正在加载 Vision…',
        failed: 'Vision 加载失败',
        retry: '重试',
        close: '关闭',
      }
}

export function VisionRouteLoading() {
  const t = interfaceCopy()
  return (
    <main className="fixed inset-0 flex items-center justify-center bg-transparent" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-xl bg-white/95 px-4 py-3 text-sm text-neutral-700 shadow-lg ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-neutral-200 dark:ring-white/10">
        <Loader2 className="animate-spin" size={16} aria-hidden="true" />
        <span>{t.loading}</span>
      </div>
    </main>
  )
}

function VisionRouteError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const desktop = useDesktop()
  const t = interfaceCopy()
  return (
    <main className="fixed inset-0 flex items-center justify-center bg-transparent p-4" role="alert">
      <div className="max-w-md rounded-2xl bg-white/95 p-5 text-neutral-800 shadow-xl ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-neutral-100 dark:ring-white/10">
        <h1 className="text-base font-semibold">{t.failed}</h1>
        <p className="mt-2 break-words text-sm text-neutral-600 dark:text-neutral-300">{error.message}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" className="primary-button" autoFocus onClick={onRetry}>{t.retry}</button>
          <button type="button" className="secondary-button" onClick={() => void desktop.hideWindow()}>{t.close}</button>
        </div>
      </div>
    </main>
  )
}

class VisionErrorBoundary extends Component<{
  children: ReactNode
  resetKey: number
  onRetry: () => void
}, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[vision-route] render failed', error, info.componentStack)
  }

  componentDidUpdate(previous: Readonly<{ resetKey: number }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error !== null) {
      return <VisionRouteError error={this.state.error} onRetry={this.props.onRetry} />
    }
    return this.props.children
  }
}

export function VisionRouteBoundary({
  children,
  resetKey,
  onRetry = () => window.location.reload(),
}: {
  children: ReactNode
  resetKey: number
  onRetry?: () => void
}) {
  return (
    <VisionErrorBoundary resetKey={resetKey} onRetry={onRetry}>
      {children}
    </VisionErrorBoundary>
  )
}
