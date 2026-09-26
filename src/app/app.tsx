import { getCurrentWindow } from '@tauri-apps/api/window'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { DesktopProvider } from '../desktop/context'
import type { DesktopPort, MainNavigationRequest, WindowRoute } from '../desktop/contract'
import { isTauriRuntime } from '../desktop/runtime'
import { useDesktop } from '../desktop/use-desktop'
import { BrowserPreviewBadge } from './browser-preview-badge'
import { OptimizerPage } from '../features/prompt-optimizer/optimizer-page'
import { SettingsPage } from '../features/settings/settings-page'
import { TranslatorPage } from '../features/translator/translator-page'
import { ExternalLinkBridge } from './external-link-bridge'
import { VisionRouteBoundary, VisionRouteLoading } from './vision-route-state'
import { WindowListenerRecovery } from './window-listener-recovery'

const ReferenceVision = lazy(() => import('../features/vision/reference-vision'))

function routeAllowedInWindow(
  nextRoute: WindowRoute,
  tauriRuntime: boolean,
  visionWindow: boolean,
  translatorWindow: boolean,
): boolean {
  if (!tauriRuntime) return true
  if (visionWindow) return nextRoute === 'vision'
  if (translatorWindow) return nextRoute === 'translator'
  return nextRoute === 'settings' || nextRoute === 'prompt-optimizer'
}

function RouteContent() {
  const desktop = useDesktop()
  const parameters = new URLSearchParams(window.location.search)
  const tauriRuntime = isTauriRuntime()
  const windowLabel = tauriRuntime ? getCurrentWindow().label : parameters.get('window')
  const visionWindow = windowLabel === 'vision' || windowLabel === 'ocr'
  const translatorWindow = tauriRuntime && getCurrentWindow().label === 'translator'
  const requestedRoute = parameters.get('route')
  const initialRoute: WindowRoute = visionWindow
    ? 'vision'
    : translatorWindow
      ? 'translator'
      : requestedRoute === 'translator' || requestedRoute === 'prompt-optimizer'
      ? requestedRoute
      : 'settings'
  const [route, setRoute] = useState<WindowRoute>(initialRoute)
  const [generation, setGeneration] = useState(0)
  const routeRef = useRef(route)
  const [pendingNavigation, setPendingNavigation] = useState<MainNavigationRequest | null>(null)
  const pendingNavigationRef = useRef<MainNavigationRequest | null>(null)
  useEffect(() => {
    pendingNavigationRef.current = pendingNavigation
  }, [pendingNavigation])
  const handleRoute = useCallback((nextRoute: WindowRoute) => {
    if (routeAllowedInWindow(nextRoute, tauriRuntime, visionWindow, translatorWindow)) {
      routeRef.current = nextRoute
      setRoute(nextRoute)
    }
  }, [tauriRuntime, translatorWindow, visionWindow])
  const handleWindowReset = useCallback((nextRoute: WindowRoute) => {
    if (!routeAllowedInWindow(nextRoute, tauriRuntime, visionWindow, translatorWindow)) return
    routeRef.current = nextRoute
    setRoute(nextRoute)
    setGeneration((value) => value + 1)
  }, [tauriRuntime, translatorWindow, visionWindow])
  const handleMainNavigationRequest = useCallback((request: MainNavigationRequest) => {
    if (!routeAllowedInWindow(request.route, tauriRuntime, visionWindow, translatorWindow)) {
      void desktop.acknowledgeMainNavigation(request.requestId, false)
      return
    }
    // Same-route requests are handled natively as focus-only. Keep this
    // defensive branch one-shot in case an older native build emits one.
    const currentRoute = routeRef.current
    if (currentRoute === request.route && request.route === 'settings') {
      void desktop.acknowledgeMainNavigation(request.requestId, true)
      return
    }
    if (currentRoute !== 'settings') {
      void desktop.acknowledgeMainNavigation(request.requestId, true)
      return
    }
    const current = pendingNavigationRef.current
    if (current !== null && current.requestId >= request.requestId) return
    setPendingNavigation(request)
  }, [desktop, tauriRuntime, translatorWindow, visionWindow])
  const resolveMainNavigationRequest = useCallback((requestId: number) => {
    setPendingNavigation((current) => current?.requestId === requestId ? null : current)
  }, [])
  const content = route === 'settings'
    ? (
        <SettingsPage
          key={`settings-${generation}`}
          navigationRequest={pendingNavigation}
          onNavigationRequestResolved={resolveMainNavigationRequest}
        />
      )
    : route === 'translator'
      ? <TranslatorPage key={`translator-${generation}`} />
      : route === 'prompt-optimizer'
        ? <OptimizerPage key={`optimizer-${generation}`} />
        : (
            <VisionRouteBoundary resetKey={generation}>
              <Suspense fallback={<VisionRouteLoading />}>
                <ReferenceVision key={`vision-${generation}`} />
              </Suspense>
            </VisionRouteBoundary>
          )
  return (
    <>
      {content}
      <WindowListenerRecovery
        onRoute={handleRoute}
        onWindowReset={handleWindowReset}
        onMainNavigationRequest={handleMainNavigationRequest}
      />
    </>
  )
}

export function App({ port }: { port?: DesktopPort } = {}) {
  return (
    <DesktopProvider {...(port === undefined ? {} : { port })}>
      <BrowserPreviewBadge />
      <ExternalLinkBridge />
      <RouteContent />
    </DesktopProvider>
  )
}
