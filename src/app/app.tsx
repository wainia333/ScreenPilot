import { getCurrentWindow } from '@tauri-apps/api/window'
import { lazy, Suspense, useCallback, useState } from 'react'
import { DesktopProvider } from '../desktop/context'
import type { WindowRoute } from '../desktop/contract'
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
  const parameters = new URLSearchParams(window.location.search)
  const tauriRuntime = '__TAURI_INTERNALS__' in window
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
  const handleRoute = useCallback((nextRoute: WindowRoute) => {
    if (routeAllowedInWindow(nextRoute, tauriRuntime, visionWindow, translatorWindow)) {
      setRoute(nextRoute)
    }
  }, [tauriRuntime, translatorWindow, visionWindow])
  const handleWindowReset = useCallback((nextRoute: WindowRoute) => {
    if (!routeAllowedInWindow(nextRoute, tauriRuntime, visionWindow, translatorWindow)) return
    setRoute(nextRoute)
    setGeneration((value) => value + 1)
  }, [tauriRuntime, translatorWindow, visionWindow])
  const content = route === 'settings'
    ? <SettingsPage key={`settings-${generation}`} />
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
      <WindowListenerRecovery onRoute={handleRoute} onWindowReset={handleWindowReset} />
    </>
  )
}

export function App() {
  return (
    <DesktopProvider>
      <ExternalLinkBridge />
      <RouteContent />
    </DesktopProvider>
  )
}
