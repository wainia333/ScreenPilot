import { getCurrentWindow } from '@tauri-apps/api/window'
import { lazy, Suspense, useEffect, useState } from 'react'
import { DesktopProvider } from '../desktop/context'
import type { WindowRoute } from '../desktop/contract'
import { useDesktop } from '../desktop/use-desktop'
import { OptimizerPage } from '../features/prompt-optimizer/optimizer-page'
import { SettingsPage } from '../features/settings/settings-page'
import { TranslatorPage } from '../features/translator/translator-page'

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
  const tauriRuntime = '__TAURI_INTERNALS__' in window
  const visionWindow = parameters.get('window') === 'vision'
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
  useEffect(() => {
    let routeUnlisten: (() => void) | undefined
    let resetUnlisten: (() => void) | undefined
    let active = true
    void desktop.onRoute((nextRoute) => {
      if (routeAllowedInWindow(nextRoute, tauriRuntime, visionWindow, translatorWindow)) {
        setRoute(nextRoute)
      }
    }).then((unlisten) => {
      if (active) routeUnlisten = unlisten
      else unlisten()
    })
    void desktop.onWindowReset((nextRoute) => {
      if (!routeAllowedInWindow(nextRoute, tauriRuntime, visionWindow, translatorWindow)) return
      setRoute(nextRoute)
      setGeneration((value) => value + 1)
    }).then((unlisten) => {
      if (active) resetUnlisten = unlisten
      else unlisten()
    })
    return () => {
      active = false
      routeUnlisten?.()
      resetUnlisten?.()
    }
  }, [desktop, tauriRuntime, translatorWindow, visionWindow])
  if (route === 'settings') return <SettingsPage key={`settings-${generation}`} />
  if (route === 'translator') return <TranslatorPage key={`translator-${generation}`} />
  if (route === 'prompt-optimizer') return <OptimizerPage key={`optimizer-${generation}`} />
  return (
    <Suspense fallback={null}>
      <ReferenceVision key={`vision-${generation}`} />
    </Suspense>
  )
}

export function App() {
  return (
    <DesktopProvider>
      <RouteContent />
    </DesktopProvider>
  )
}
