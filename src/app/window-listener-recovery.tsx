import { useCallback, useEffect, useRef, useState } from 'react'
import type { WindowRoute } from '../desktop/contract'
import { useDesktop } from '../desktop/use-desktop'

type ListenerKind = 'route' | 'reset'
type ListenerErrors = Partial<Record<ListenerKind, string>>

type WindowListenerRecoveryProps = {
  onRoute: (route: WindowRoute) => void
  onWindowReset: (route: WindowRoute) => void
}

function listenerErrorCopy() {
  const english = document.documentElement.lang.startsWith('en')
  return english
    ? {
        title: 'Window updates are unavailable',
        route: 'Navigation updates could not be connected.',
        reset: 'Window reset updates could not be connected.',
        retry: 'Retry',
        close: 'Close',
        closeFailed: 'Unable to close the window. Please try again.',
      }
    : {
        title: '窗口更新暂不可用',
        route: '无法连接页面导航更新。',
        reset: '无法连接窗口重置更新。',
        retry: '重试',
        close: '关闭',
        closeFailed: '关闭窗口失败，请重试。',
      }
}

export function WindowListenerRecovery({ onRoute, onWindowReset }: WindowListenerRecoveryProps) {
  const desktop = useDesktop()
  const [listenerErrors, setListenerErrors] = useState<ListenerErrors>({})
  const [closeError, setCloseError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const routeUnlistenRef = useRef<(() => void) | null>(null)
  const resetUnlistenRef = useRef<(() => void) | null>(null)
  const activeRef = useRef(false)
  const attemptRef = useRef<Record<ListenerKind, number>>({ route: 0, reset: 0 })
  const installListener = useCallback((kind: ListenerKind) => {
    const unlistenRef = kind === 'route' ? routeUnlistenRef : resetUnlistenRef
    if (!activeRef.current || unlistenRef.current !== null) return Promise.resolve(true)
    const attempt = attemptRef.current[kind] + 1
    attemptRef.current[kind] = attempt
    const registration = kind === 'route'
      ? desktop.onRoute(onRoute)
      : desktop.onWindowReset(onWindowReset)
    return registration.then((unlisten) => {
      if (!activeRef.current || attempt !== attemptRef.current[kind]) {
        unlisten()
        return false
      }
      unlistenRef.current = unlisten
      setListenerErrors((current) => {
        if (current[kind] === undefined) return current
        return kind === 'route'
          ? { ...(current.reset === undefined ? {} : { reset: current.reset }) }
          : { ...(current.route === undefined ? {} : { route: current.route }) }
      })
      return true
    }).catch((reason: unknown) => {
      console.error(`[app] failed to register ${kind === 'route' ? 'route' : 'window reset'} listener`, reason)
      if (activeRef.current && attempt === attemptRef.current[kind]) {
        setListenerErrors((current) => ({ ...current, [kind]: String(reason) }))
      }
      return false
    })
  }, [desktop, onRoute, onWindowReset])

  useEffect(() => {
    const attempts = attemptRef.current
    activeRef.current = true
    void installListener('route')
    void installListener('reset')
    return () => {
      activeRef.current = false
      attempts.route += 1
      attempts.reset += 1
      routeUnlistenRef.current?.()
      resetUnlistenRef.current?.()
      routeUnlistenRef.current = null
      resetUnlistenRef.current = null
    }
  }, [installListener])

  const retryFailedListeners = async () => {
    const failed = (['route', 'reset'] as const).filter((kind) => listenerErrors[kind] !== undefined)
    if (failed.length === 0 || retrying) return
    setRetrying(true)
    setCloseError(null)
    await Promise.all(failed.map((kind) => installListener(kind)))
    if (activeRef.current) setRetrying(false)
  }
  const close = async () => {
    setCloseError(null)
    try {
      await desktop.hideWindow()
    } catch {
      setCloseError(listenerErrorCopy().closeFailed)
    }
  }
  const failedListeners = (['route', 'reset'] as const).filter((kind) => listenerErrors[kind] !== undefined)
  if (failedListeners.length === 0) return null
  const t = listenerErrorCopy()
  return (
    <aside className="fixed inset-x-4 bottom-4 z-[100] mx-auto max-w-md rounded-2xl bg-white/95 p-4 text-neutral-800 shadow-xl ring-1 ring-black/5 dark:bg-neutral-900/95 dark:text-neutral-100 dark:ring-white/10" role="alert">
      <h2 className="text-sm font-semibold">{t.title}</h2>
      {failedListeners.map((kind) => (
        <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400" key={kind}>
          {t[kind]} {listenerErrors[kind]}
        </p>
      ))}
      {closeError === null ? null : <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{closeError}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" className="primary-button" disabled={retrying} onClick={() => void retryFailedListeners()}>
          {retrying ? `${t.retry}…` : t.retry}
        </button>
        <button type="button" className="secondary-button" onClick={() => void close()}>{t.close}</button>
      </div>
    </aside>
  )
}
