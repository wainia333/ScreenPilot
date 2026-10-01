import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../vendor/screenshot/api/tauri'
import { latestReferences, type HistoricalBookmark, type KarakeepConfig, type KnowledgeEvent, type KnowledgeMessage, type KnowledgeRequest, type SourcePolicy } from './types'

export function useVisionKnowledge(isCurrent: (requestId: string) => boolean, update: (event: KnowledgeEvent) => void) {
  const [mode, setMode] = useState<SourcePolicy>('auto')
  const [includeWeb, setIncludeWeb] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [selected, setSelected] = useState<HistoricalBookmark | null>(null)
  const [event, setEvent] = useState<KnowledgeEvent | null>(null)
  const callbacks = useRef({ isCurrent, update })
  useLayoutEffect(() => { callbacks.current = { isCurrent, update } }, [isCurrent, update])
  const listener = useRef<Promise<boolean> | null>(null)
  const configuration = useRef<KarakeepConfig | undefined>(undefined)
  const keyPresent = useRef(false)
  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    if (typeof api.onVisionKnowledge !== 'function') return
    listener.current = api.onVisionKnowledge(payload => {
      if (!active || !callbacks.current.isCurrent(payload.requestId)) return
      setEvent(payload)
      callbacks.current.update(payload)
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); return active }).catch(() => false)
    return () => { active = false; unlisten?.(); listener.current = null }
  }, [])
  const configure = useCallback((config?: KarakeepConfig, keyConfigured?: boolean) => {
    configuration.current = config
    keyPresent.current = keyConfigured ?? false
    setConfigured(!!config?.enabled && !!config.baseUrl && keyConfigured !== false)
    setMode(config?.visionPolicy ?? 'auto')
    setIncludeWeb(false)
    setSelected(null)
    setEvent(null)
  }, [])
  useEffect(() => {
    let active = true
    const subscriptions: Promise<() => void>[] = []
    if (typeof api.onKarakeepSettingsChanged === 'function') subscriptions.push(api.onKarakeepSettingsChanged(config => {
      if (active && JSON.stringify(config) !== JSON.stringify(configuration.current)) configure(config, keyPresent.current)
    }))
    if (typeof api.onKarakeepCredentialChanged === 'function') subscriptions.push(api.onKarakeepCredentialChanged(present => {
      if (active) configure(configuration.current, present)
    }))
    return () => { active = false; subscriptions.forEach(p => { void p.then(dispose => dispose()).catch(() => undefined) }) }
  }, [configure])
  const prepare = async (requestId: string) => {
    setEvent(null)
    if (configured && listener.current && !await listener.current) throw new Error('收藏库事件监听失败，请重新打开 Vision')
    return callbacks.current.isCurrent(requestId)
  }
  const request = (messages: readonly KnowledgeMessage[]): KnowledgeRequest => ({ mode, includeWeb, references: latestReferences(messages), ...(selected ? { selected } : {}) })
  return { mode, includeWeb, configured, selected, event, configure, prepare, request,
    select: setSelected, change: (next: SourcePolicy, web: boolean) => { setMode(next); setIncludeWeb(web); setSelected(null) },
    reset: () => { setSelected(null); setEvent(null) } }
}
