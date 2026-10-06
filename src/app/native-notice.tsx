import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauriRuntime } from '../desktop/runtime'
import { TopNotice } from '../shared/ui/top-notice'

export function NativeNotice() {
  const [notice, setNotice] = useState<{ message: string; tone: 'error' | 'status'; sequence: number } | null>(null)
  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false, stop: (() => void) | undefined, sequence = 0
    void listen<{ message: string; tone: 'error' | 'status' }>('screenpilot:notice', e => {
      if (!disposed) {
        const next = { ...e.payload, sequence: ++sequence }
        setNotice(current => current?.message === next.message && current.tone === next.tone ? current : next)
      }
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten })
    return () => { disposed = true; stop?.() }
  }, [])
  return notice && <TopNotice {...notice} language={document.documentElement.lang.startsWith('en') ? 'en' : 'zh'} portal onDismiss={() => setNotice(null)} />
}
