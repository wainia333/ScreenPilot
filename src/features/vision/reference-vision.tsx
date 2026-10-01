import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, Play } from 'lucide-react'
import { createPortal } from 'react-dom'
import { karakeepVisionUi } from '../karakeep/default-vision-ui'
import ReferenceVision from '../../vendor/screenshot/Vision'
import { api as referenceVisionApi } from '../../vendor/screenshot/api/tauri'
import '../../vendor/screenshot/index.css'
import { copyToClipboard } from '../../vendor/screenshot/utils/clipboard'
import { i18n as visionI18n } from '../../vendor/screenshot/settings/i18n'
import './vision-adapter.css'
import { safeExternalUrl } from './citation-links'
import {
  shouldGrowOcrFloatingWindow,
  VISION_FLOATING_PADDING,
  visionDialogHeight,
} from './dialog-sizing'
import { isVisionPromptInput, scheduleVisionPromptCaretSync } from './prompt-input-scroll'
import { installSafeFloatingDrag } from './safe-floating-drag'
import { copyFor, translationLanguageOptions } from '../../shared/ui-copy'
import type { InterfaceLanguage } from '../settings/types'
import { syncDocumentTheme, type DocumentTheme } from '../../shared/theme'
import { MarkdownView } from '../../shared/markdown/markdown-view'

type TargetLanguage = 'auto' | 'zh-CN' | 'en' | 'ja' | 'ko'
type SourceLanguage = TargetLanguage

type ReferenceSettings = {
  settingsLanguage?: InterfaceLanguage
  theme?: DocumentTheme
  translationAiEnabled?: boolean
  translatorProviderId?: string
  translatorModel?: string
  screenshotTranslation: Record<string, unknown> & {
    sourceLanguage?: SourceLanguage
    targetLanguage?: TargetLanguage
    ocrAiEnabled?: boolean
    translationAiEnabled?: boolean
    providerId?: string
    model?: string
    translateProviderId?: string
    translateModel?: string
  }
  [key: string]: unknown
}

type TranslateResult = {
  success: boolean
  cancelled?: boolean
  translated?: string
  error?: string
}

type TranslateStreamPayload = {
  imageId?: string
  kind?: 'original' | 'translated'
  generation?: number
  delta?: string
  done?: boolean
}

type OverrideResult = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  text: string
  error?: string
  stale: boolean
}

type LanguageField = 'source' | 'target'

type LanguagePair = {
  source: SourceLanguage
  target: TargetLanguage
}

type LanguageFlow = {
  confirmed: LanguagePair
  desired: LanguagePair
  fieldVersions: Record<LanguageField, number>
  epoch: number
  saving: boolean
  queue: Promise<void>
}

const supportedLanguages = new Set<TargetLanguage>(['auto', 'zh-CN', 'en', 'ja', 'ko'])

const languageHost = document.createElement('span')
const sourceLanguageHost = document.createElement('span')
const targetActionsHost = document.createElement('span')
const resultHost = document.createElement('div')
const settledTranslateCards = new WeakSet<HTMLElement>()
const requestedTranslateHeights = new WeakMap<HTMLElement, number>()
const translateFloatingContentWidths = new WeakMap<HTMLElement, number>()
const OCR_FLOATING_MAX_HEIGHT = 400
languageHost.dataset.screenpilotTargetLanguage = 'true'
sourceLanguageHost.dataset.screenpilotSourceLanguage = 'true'
targetActionsHost.dataset.screenpilotTargetActions = 'true'
resultHost.dataset.screenpilotTargetResult = 'true'

type TranslationOverrideActionsProps = {
  text: string
  loading: boolean
  lang: InterfaceLanguage
}

function TranslationOverrideActions({ text, loading, lang }: TranslationOverrideActionsProps) {
  const labels = visionI18n[lang]
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [speechState, setSpeechState] = useState<'idle' | 'loading' | 'speaking' | 'failed'>('idle')
  const speechSequenceRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stopSpeech = useCallback(() => {
    speechSequenceRef.current += 1
    audioRef.current?.pause()
    audioRef.current = null
    setSpeechState('idle')
  }, [])

  useEffect(() => () => {
    speechSequenceRef.current += 1
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  const copy = async () => {
    if (loading || !text.trim()) return
    const ok = await copyToClipboard(text)
    if (!ok) {
      setCopyState('failed')
      return
    }
    setCopyState('copied')
    window.setTimeout(() => setCopyState('idle'), 1400)
  }

  const speak = async () => {
    if (loading || !text.trim()) return
    if (speechState === 'loading' || speechState === 'speaking') {
      stopSpeech()
      return
    }
    const sequence = speechSequenceRef.current + 1
    speechSequenceRef.current = sequence
    setSpeechState('loading')
    try {
      const result = await referenceVisionApi.synthesizeSpeech(text)
      if (sequence !== speechSequenceRef.current) return
      if (!result.success || !result.data) throw new Error(result.error ?? labels.visionSpeechFailed)
      const audio = new Audio(result.data)
      audioRef.current = audio
      setSpeechState('speaking')
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve()
        audio.onpause = () => {
          if (!audio.ended) resolve()
        }
        audio.onerror = () => reject(new Error('Audio playback failed'))
        void audio.play().catch(reject)
      })
      if (sequence === speechSequenceRef.current) setSpeechState('idle')
    } catch (error) {
      if (sequence === speechSequenceRef.current) {
        setSpeechState('failed')
        console.error('[vision-translation] speech failed:', error)
      }
    } finally {
      if (sequence === speechSequenceRef.current) {
        audioRef.current = null
      }
    }
  }

  if (!text.trim()) return null
  const speechLabel = speechState === 'failed'
    ? labels.visionSpeechRetry
    : speechState === 'loading' || speechState === 'speaking'
      ? labels.visionStop
      : labels.visionSpeak
  const copyLabel = copyState === 'copied' ? labels.visionCopied : labels.visionCopy
  const disabled = loading

  return (
    <span className="screenpilot-target-actions" data-screenpilot-target-actions="true">
      <button
        type="button"
        data-screenpilot-target-action="copy"
        data-screenpilot-copy-target="translated-override"
        data-screenpilot-copy-state={copyState}
        aria-label={copyLabel}
        title={copyLabel}
        disabled={disabled}
        onClick={() => void copy()}
        className="screenpilot-target-action"
      >
        {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <button
        type="button"
        data-screenpilot-target-action="speak"
        data-screenpilot-speak-target="translated-override"
        data-screenpilot-speech-state={speechState}
        aria-label={speechLabel}
        title={speechLabel}
        disabled={disabled}
        onClick={() => void speak()}
        className="screenpilot-target-action"
      >
        {speechState === 'loading' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} fill="currentColor" />}
      </button>
      {copyState === 'failed' ? <span role="alert" className="sr-only">{labels.visionCopyFailed}</span> : null}
      {speechState === 'failed' ? <span role="alert" className="sr-only">{labels.visionSpeechFailed}</span> : null}
    </span>
  )
}

function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && supportedLanguages.has(value as TargetLanguage)
}

function findTranslationMethodSelect(root: ParentNode | null): HTMLSelectElement | null {
  return root?.querySelector<HTMLSelectElement>('[data-screenpilot-translation-method="true"]') ?? null
}

function visibleOcrSource(root: ParentNode | null): string {
  const source = root?.querySelector<HTMLElement>('[data-screenpilot-ocr-source-content="true"]')
  return source?.innerText.trim() ?? ''
}

function visibleNativeTranslation(root: ParentNode | null): string {
  const result = root?.querySelector<HTMLElement>('[data-screenpilot-native-translation-result="true"]')
  const dataText = result?.dataset.screenpilotTranslationText?.trim()
  if (dataText) return dataText
  return result?.innerText.trim() ?? ''
}

function setAttributeIfChanged(element: HTMLElement, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

function setBooleanAttribute(element: HTMLElement, name: string, enabled: boolean) {
  if (enabled) setAttributeIfChanged(element, name, 'true')
  else if (element.hasAttribute(name)) element.removeAttribute(name)
}

function setCssPropertyIfChanged(element: HTMLElement, name: string, value: string) {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
}

function clearCssProperty(element: HTMLElement, name: string) {
  if (element.style.getPropertyValue(name)) element.style.removeProperty(name)
}

function initialVisionViewportHeight(): number {
  if (typeof window === 'undefined') return 800
  const innerHeight = window.innerHeight
  const screenHeight = window.screen.height
  const heights = [innerHeight, screenHeight].filter((height) => Number.isFinite(height) && height > 0)
  return heights.length > 0 ? Math.max(...heights) : 800
}

function isFloatingResultSurface(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  // Vision marks the compact native layout explicitly. During a real edge
  // resize React may commit the measured client width one frame after the
  // browser's `resize` event; keep the floating dialog contract alive during
  // that hand-off instead of treating the temporarily narrower card as a
  // fullscreen surface and dropping its height variables.
  const floatingLayout = element.closest('[data-screenpilot-floating-layout="true"]') !== null
  if (floatingLayout) {
    const floatingRoot = element.closest<HTMLElement>('[data-screenpilot-floating-layout="true"]')
    const expectedWidth = Number(floatingRoot?.dataset.screenpilotFloatingWidth ?? '')
    const viewportMatchesFloatingWidth = Number.isFinite(expectedWidth)
      && Math.abs(window.innerWidth - expectedWidth) <= 24
    if (!viewportMatchesFloatingWidth) {
      // Before the native resize reaches WebView2 (or in a fullscreen mock),
      // fall back to the original surface geometry rather than trusting the
      // marker against an unrelated viewport.
      return rect.left >= -2
        && rect.left <= 24
        && Math.abs(rect.right - window.innerWidth) <= 24
        && rect.width >= window.innerWidth - 24
        && window.innerHeight > 96
    }
    return rect.left >= -24
      && rect.top >= -24
      && rect.width > 0
      && rect.height > 0
      && window.innerWidth > 0
      && window.innerHeight > 96
  }
  return rect.left >= -2
    && rect.left <= 24
    && Math.abs(rect.right - window.innerWidth) <= 24
    && rect.width >= window.innerWidth - 24
    && window.innerHeight > 96
}

function clearFloatingDialogLayout(element: HTMLElement) {
  element.removeAttribute('data-screenpilot-floating-dialog-card')
  clearCssProperty(element, '--screenpilot-floating-dialog-height')
  clearCssProperty(element, '--screenpilot-floating-dialog-min-height')
}

function syncFloatingDialogLayout(
  element: HTMLElement,
  height: number,
  floatingSurface: HTMLElement = element,
  minimumHeight = 1,
) {
  if (!isFloatingResultSurface(floatingSurface)) {
    clearFloatingDialogLayout(element)
    return
  }

  const resolvedMinimum = Math.max(1, Math.floor(minimumHeight))
  setAttributeIfChanged(element, 'data-screenpilot-floating-dialog-card', 'true')
  setCssPropertyIfChanged(
    element,
    '--screenpilot-floating-dialog-min-height',
    `${String(resolvedMinimum)}px`,
  )
  setCssPropertyIfChanged(
    element,
    '--screenpilot-floating-dialog-height',
    `${String(Math.max(resolvedMinimum, Math.floor(height)))}px`,
  )
}

export default function ReferenceVisionAdapter() {
  const adapterRootRef = useRef<HTMLElement>(null)
  const [interfaceLanguage, setInterfaceLanguage] = useState<InterfaceLanguage>('zh')
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>('auto')
  const [targetLanguage, setTargetLanguage] = useState<TargetLanguage>('auto')
  const [overrideResult, setOverrideResult] = useState<OverrideResult>({ status: 'idle', text: '', stale: false })
  const [languageSaveError, setLanguageSaveError] = useState<string | null>(null)
  // Capture the desktop/fullscreen viewport before Vision rebases its webview
  // to the compact native floating window. This is the same viewport used by
  // the vendor's initial answer metrics and remains stable during a drag.
  const referenceViewportHeightRef = useRef(initialVisionViewportHeight())
  const sourceRef = useRef({ imageId: '', text: '' })
  const sourceGenerationRef = useRef(0)
  const requestSequenceRef = useRef(0)
  const sourceLanguageRef = useRef<SourceLanguage>('auto')
  const targetLanguageRef = useRef<TargetLanguage>('auto')
  const overrideResultRef = useRef<OverrideResult>({ status: 'idle', text: '', stale: false })
  const languageFlowRef = useRef<LanguageFlow>({
    confirmed: { source: 'auto', target: 'auto' },
    desired: { source: 'auto', target: 'auto' },
    fieldVersions: { source: 0, target: 0 },
    epoch: 0,
    saving: false,
    queue: Promise.resolve(),
  })
  const mountedRef = useRef(true)
  const overrideLockedRef = useRef(false)
  const aiAvailabilityRef = useRef({ ocr: true, translation: true })
  const aiAvailabilityLoadedRef = useRef(false)
  const t = copyFor(interfaceLanguage)
  const targetLanguageOptions = translationLanguageOptions(interfaceLanguage)
  const sourceLanguageOptions = targetLanguageOptions

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(
    () => installSafeFloatingDrag(referenceVisionApi, invoke),
    [],
  )

  useEffect(() => {
    const onLinkClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      if (!(event.target instanceof Element)) return
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
      if (anchor === null) return
      const href = anchor.getAttribute('href')
      if (href === null) return
      const safeUrl = safeExternalUrl(href)
      event.preventDefault()
      event.stopPropagation()
      if (safeUrl === null) return
      void invoke('open_external', { url: safeUrl }).catch((error: unknown) => {
        console.error('Failed to open citation link', error)
      })
    }
    document.addEventListener('click', onLinkClick, true)
    return () => document.removeEventListener('click', onLinkClick, true)
  }, [])

  const clearOverride = useCallback(() => {
    overrideLockedRef.current = false
    requestSequenceRef.current += 1
    overrideResultRef.current = { status: 'idle', text: '', stale: false }
    setOverrideResult(overrideResultRef.current)
  }, [])

  useEffect(() => {
    overrideResultRef.current = overrideResult
  }, [overrideResult])

  useEffect(() => {
    let active = true
    let request = 0
    const loadSettings = () => {
      const currentRequest = request + 1
      request = currentRequest
      void invoke<ReferenceSettings>('vision_runtime_settings_load').then((settings) => {
        if (!active || currentRequest !== request) return
      syncDocumentTheme(settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system')
      const loadedLanguage = settings.settingsLanguage === 'en' ? 'en' : 'zh'
      setInterfaceLanguage(loadedLanguage)
      document.documentElement.lang = loadedLanguage === 'zh' ? 'zh-CN' : 'en'
      const ocrWindow = new URLSearchParams(window.location.search).get('window') === 'ocr'
      document.title = ocrWindow ? (loadedLanguage === 'zh' ? 'ScreenPilot — OCR翻译' : 'ScreenPilot — OCR Translation') : 'ScreenPilot — Vision'
      if ('__TAURI_INTERNALS__' in window) {
        void getCurrentWindow().setTitle(document.title).catch((error: unknown) => {
          console.error('Failed to set the Vision window title', error)
        })
      }
      const configuredSource = settings.screenshotTranslation.sourceLanguage
      const configured = settings.screenshotTranslation.targetLanguage
      const nextSource = isTargetLanguage(configuredSource) ? configuredSource : 'auto'
      const nextTarget = isTargetLanguage(configured) ? configured : 'auto'
      const flow = languageFlowRef.current
      flow.epoch += 1
      flow.confirmed = { source: nextSource, target: nextTarget }
      flow.desired = { source: nextSource, target: nextTarget }
      flow.fieldVersions = { source: flow.fieldVersions.source + 1, target: flow.fieldVersions.target + 1 }
      sourceLanguageRef.current = nextSource
      targetLanguageRef.current = nextTarget
      setSourceLanguage(nextSource)
      setTargetLanguage(nextTarget)
      if (mountedRef.current) setLanguageSaveError(null)
      const screenshot = settings.screenshotTranslation
      aiAvailabilityRef.current = {
        ocr: screenshot.ocrAiEnabled === true
          && typeof screenshot.providerId === 'string'
          && screenshot.providerId.length > 0
          && typeof screenshot.model === 'string'
          && screenshot.model.length > 0,
        translation: screenshot.translationAiEnabled === true
          && typeof screenshot.translateProviderId === 'string'
          && screenshot.translateProviderId.length > 0
          && typeof screenshot.translateModel === 'string'
          && screenshot.translateModel.length > 0,
      }
      aiAvailabilityLoadedRef.current = true
      window.dispatchEvent(new Event('screenpilot-ai-availability'))
    }).catch((error: unknown) => {
      if (!active || currentRequest !== request) return
      aiAvailabilityRef.current = { ocr: false, translation: false }
      aiAvailabilityLoadedRef.current = true
      window.dispatchEvent(new Event('screenpilot-ai-availability'))
      console.error('Failed to load screenshot target language', error)
    })
    }
    loadSettings()
    const resetSession = () => {
      sourceRef.current = { imageId: '', text: '' }
      sourceGenerationRef.current = 0
      clearOverride()
    }
    const handleVisionReset = () => {
      resetSession()
      loadSettings()
    }
    window.addEventListener('vision:reset', handleVisionReset)
    window.addEventListener('screenpilot:vision-session-reset', resetSession)
    return () => {
      active = false
      request += 1
      window.removeEventListener('vision:reset', handleVisionReset)
      window.removeEventListener('screenpilot:vision-session-reset', resetSession)
    }
  }, [clearOverride])

  useEffect(() => {
    let dispose: (() => void) | undefined
    let active = true
    void listen<TranslateStreamPayload>('vision-translate-stream', ({ payload }) => {
      if (payload.kind !== 'original' || !payload.delta) return
      if (payload.generation === undefined) {
        if (sourceGenerationRef.current > 0) return
      } else {
        if (payload.generation < sourceGenerationRef.current) return
        sourceGenerationRef.current = payload.generation
      }
      const imageId = payload.imageId ?? ''
      sourceRef.current = {
        imageId,
        text: payload.delta,
      }
      if (!overrideLockedRef.current) clearOverride()
    }, { target: getCurrentWindow().label }).then((unlisten) => {
      if (active) dispose = unlisten
      else unlisten()
    }).catch((error: unknown) => console.error('Failed to observe screenshot translation', error))
    return () => {
      active = false
      dispose?.()
    }
  }, [clearOverride])

  useEffect(() => {
    let adapterFrame: number | null = null
    const applyAdaptersNow = () => {
      const adapterRoot = adapterRootRef.current
      if (adapterRoot === null) return
      const visionRoot = adapterRoot.querySelector<HTMLElement>('[data-screenpilot-vision-root="true"]')
      if (visionRoot === null) return

      const send = visionRoot.querySelector<HTMLButtonElement>('[data-screenpilot-vision-send="true"]')
      if (send !== null) send.setAttribute('aria-label', t.send)

      const promptBar = visionRoot.querySelector<HTMLElement>('[data-screenpilot-prompt-bar="true"]')
      const promptPanel = visionRoot.querySelector<HTMLElement>('[data-screenpilot-prompt-panel="true"]')
      if (promptBar instanceof HTMLElement) {
        setAttributeIfChanged(promptBar, 'data-screenpilot-window-frame', 'true')
      }
      if (promptPanel instanceof HTMLElement) {
        const promptPreviewCard = promptPanel.querySelector<HTMLElement>('[data-screenpilot-vision-prompt-preview="true"]')
        const hasScreenshot = promptBar?.dataset.screenpilotVisionImage !== 'false'
        const dialogInitialHeight = visionDialogHeight(referenceViewportHeightRef.current, hasScreenshot)
        const dialogMinimumHeight = dialogInitialHeight
        if (promptPreviewCard !== null) {
          setCssPropertyIfChanged(
            promptPreviewCard,
            '--screenpilot-dialog-initial-height',
            `${String(dialogInitialHeight)}px`,
          )
          const top = promptPreviewCard.getBoundingClientRect().top
          syncFloatingDialogLayout(
            promptPreviewCard,
            window.innerHeight - top - VISION_FLOATING_PADDING,
            promptPanel,
            dialogMinimumHeight,
          )
        }
        const answerCard = promptPanel.querySelector<HTMLElement>('[data-screenpilot-answer-panel="true"]')
        if (
          answerCard instanceof HTMLElement
          && promptPanel.dataset.screenpilotAnswerVisible === 'true'
        ) {
          setCssPropertyIfChanged(
            answerCard,
            '--screenpilot-dialog-initial-height',
            `${String(dialogInitialHeight)}px`,
          )
          const top = answerCard.getBoundingClientRect().top
          syncFloatingDialogLayout(
            answerCard,
            window.innerHeight - top - VISION_FLOATING_PADDING,
            promptPanel,
            dialogMinimumHeight,
          )
        } else {
          visionRoot.querySelectorAll<HTMLElement>('[data-screenpilot-answer-panel="true"]').forEach((card) => {
            clearFloatingDialogLayout(card)
            clearCssProperty(card, '--screenpilot-dialog-initial-height')
          })
        }
      } else {
        visionRoot.querySelectorAll<HTMLElement>('[data-screenpilot-floating-dialog-card="true"]').forEach((card) => {
          clearFloatingDialogLayout(card)
        })
        visionRoot.querySelectorAll<HTMLElement>('[data-screenpilot-vision-prompt-preview="true"]').forEach((card) => {
          clearCssProperty(card, '--screenpilot-dialog-initial-height')
        })
      }

      const methodSelect = findTranslationMethodSelect(visionRoot)
      const availability = aiAvailabilityRef.current
      visionRoot.querySelectorAll<HTMLSelectElement>(
        '[data-screenpilot-ocr-method="true"], [data-screenpilot-translation-method="true"]',
      ).forEach((select) => {
        const ocr = select.dataset.screenpilotOcrMethod === 'true'
        const allowed = !aiAvailabilityLoadedRef.current || (ocr ? availability.ocr : availability.translation)
        if (!allowed) {
          select.querySelector('option[value="ai"]')?.remove()
          if (select.value === 'ai') {
            select.value = ocr ? 'chaoxing' : 'microsoft'
            select.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
      })
      const translateCard = visionRoot.querySelector<HTMLElement>('[data-screenpilot-translation-card="true"]')
      const header = translateCard?.querySelector<HTMLElement>('[data-screenpilot-translation-header="true"]') ?? null
      const body = translateCard?.querySelector<HTMLElement>('[data-screenpilot-translation-body="true"]') ?? null
      const heading = body?.querySelector<HTMLElement>('[data-screenpilot-translated-heading="true"]') ?? null
      const source = body?.querySelector<HTMLElement>('[data-screenpilot-ocr-container="true"]') ?? null
      const sourceHeading = source?.querySelector<HTMLElement>('[data-screenpilot-original-heading="true"]') ?? null
      const sourceLanguageSlot = sourceHeading?.querySelector<HTMLElement>('[data-screenpilot-source-language-slot="true"]') ?? null
      const targetLanguageSlot = heading?.querySelector<HTMLElement>('[data-screenpilot-target-language-slot="true"]') ?? null
      const targetResultSlot = body?.querySelector<HTMLElement>('[data-screenpilot-target-result-slot="true"]') ?? null
      if (
        methodSelect === null
        || translateCard === null
        || header === null
        || body === null
        || heading === null
        || targetLanguageSlot === null
        || targetResultSlot === null
      ) {
        document.documentElement.removeAttribute('data-screenpilot-floating-translate-window')
        document.documentElement.removeAttribute('data-screenpilot-floating-translate-pending')
        return
      }
      translateCard.setAttribute('data-screenpilot-window-frame', 'true')
      // The screenshot-translation/OCR result card is the one Vision surface
      // outside the reference component that should receive the same frosted
      // transparency as `.window-frosted`. Keep it explicitly scoped so the
      // regular Vision prompt and answer frames are untouched.
      translateCard.setAttribute('data-screenpilot-ocr-card', 'true')
      const translateRect = translateCard.getBoundingClientRect()
      const translateLayoutWidth = translateCard.offsetWidth
      const floatingTranslateSurface = isFloatingResultSurface(translateCard)
      const floatingTranslateMatchesViewport = floatingTranslateSurface
        && Math.abs(window.innerHeight - VISION_FLOATING_PADDING * 2 - translateRect.height) <= 12
      if (floatingTranslateMatchesViewport) {
        settledTranslateCards.add(translateCard)
      }
      const floatingTranslateSettled = floatingTranslateSurface
        && settledTranslateCards.has(translateCard)
      if (floatingTranslateSurface) {
        // `transition-property: none` is the vendor surface's explicit rebase
        // phase. During that interval Rust is about to run the native HWND
        // flight with its compact geometry, so an adapter resize would be
        // overwritten a frame later and appear as a vertical kick. Wait for
        // the post-flight style commit before taking sole ownership of height.
        const nativeFlightActive = translateCard.dataset.screenpilotNativeFlightActive === 'true'
        const initialContentWidth = Math.ceil(
          translateLayoutWidth > 0 ? translateLayoutWidth : translateRect.width,
        )
        if (!translateFloatingContentWidths.has(translateCard) && initialContentWidth > 0) {
          translateFloatingContentWidths.set(translateCard, initialContentWidth)
        }
        const headerHeight = header.getBoundingClientRect().height
        const desiredHeight = Math.min(
          OCR_FLOATING_MAX_HEIGHT,
          Math.ceil(headerHeight + body.scrollHeight),
        )
        // The card is allowed to lay out past the cropped WebView viewport
        // while the compact native flight is settling. Comparing against its
        // own DOM rect would therefore report 400px even when the HWND exposes
        // only 224px and leave the pending card permanently invisible. Size
        // against the actual client viewport available inside the 8px insets.
        const availableContentHeight = Math.max(
          0,
          window.innerHeight - VISION_FLOATING_PADDING * 2,
        )
        const lastRequestedHeight = requestedTranslateHeights.get(translateCard)
        if (shouldGrowOcrFloatingWindow(
          nativeFlightActive,
          desiredHeight,
          availableContentHeight,
          lastRequestedHeight,
        )) {
          // OCR only grows to fit new content. Remember the largest request for
          // this mounted card instead of clearing it when WebView2 reports the
          // applied size; otherwise a one-pixel resize echo can submit the same
          // HWND geometry over and over again.
          requestedTranslateHeights.set(translateCard, desiredHeight)
          const contentWidth = translateFloatingContentWidths.get(translateCard)
            ?? initialContentWidth
          void invoke<boolean>('vision_set_floating', {
            rect: {
              width: contentWidth + VISION_FLOATING_PADDING * 2,
              height: desiredHeight + VISION_FLOATING_PADDING * 2,
            },
          }).then((applied) => {
            if (!applied && requestedTranslateHeights.get(translateCard) === desiredHeight) {
              requestedTranslateHeights.delete(translateCard)
            }
          }).catch((error: unknown) => {
            if (requestedTranslateHeights.get(translateCard) === desiredHeight) {
              requestedTranslateHeights.delete(translateCard)
            }
            console.error('Failed to expand screenshot translation window', error)
          })
        }
      }
      setBooleanAttribute(translateCard, 'data-screenpilot-floating-translate-surface', floatingTranslateSurface)
      setBooleanAttribute(translateCard, 'data-screenpilot-floating-translate-card', floatingTranslateSettled)
      setBooleanAttribute(
        document.documentElement,
        'data-screenpilot-floating-translate-window',
        floatingTranslateSettled,
      )
      setBooleanAttribute(
        document.documentElement,
        'data-screenpilot-floating-translate-pending',
        floatingTranslateSurface && !floatingTranslateSettled,
      )
      if (source !== null && source.querySelector('[data-screenpilot-ocr-source-content="true"]') !== null) {
        const reachedHeightLimit = floatingTranslateSettled
          && window.innerHeight >= OCR_FLOATING_MAX_HEIGHT + VISION_FLOATING_PADDING * 2 - 1
        if (reachedHeightLimit) {
          const sourceHeight = Math.max(92, Math.floor(body.getBoundingClientRect().height * 0.42))
          source.dataset.screenpilotOcrSource = 'true'
          setCssPropertyIfChanged(source, '--screenpilot-ocr-source-max-height', `${String(sourceHeight)}px`)
        } else {
          source.removeAttribute('data-screenpilot-ocr-source')
          clearCssProperty(source, '--screenpilot-ocr-source-max-height')
        }
      }
      if (sourceHeading !== null && sourceLanguageSlot !== null) {
        if (sourceLanguageHost.parentNode !== sourceLanguageSlot) sourceLanguageSlot.append(sourceLanguageHost)
      } else {
        sourceLanguageHost.remove()
      }
      if (languageHost.parentNode !== targetLanguageSlot) targetLanguageSlot.append(languageHost)
      if (targetActionsHost.parentNode !== heading) heading.insertBefore(targetActionsHost, targetLanguageSlot)
      heading.querySelectorAll<HTMLButtonElement>('button:not([data-screenpilot-target-action="copy"]):not([data-screenpilot-target-action="speak"])').forEach((button) => {
        const nativeActionsBlocked = overrideResult.status !== 'idle' || languageSaveError !== null
        button.disabled = nativeActionsBlocked
        setBooleanAttribute(button, 'aria-disabled', nativeActionsBlocked)
      })
      if (resultHost.parentNode !== targetResultSlot) targetResultSlot.append(resultHost)
    }

    const applyAdapters = () => {
      if (adapterFrame !== null) return
      adapterFrame = window.requestAnimationFrame(() => {
        adapterFrame = null
        applyAdaptersNow()
      })
    }

    applyAdapters()
    const observer = new MutationObserver(applyAdapters)
    const adapterRoot = adapterRootRef.current
    if (adapterRoot === null) return
    observer.observe(adapterRoot, {
      childList: true,
      subtree: true,
    })
    const handleInput = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.dataset.screenpilotOcrSourceContent !== 'true') return
      sourceRef.current = { imageId: sourceRef.current.imageId, text: target.innerText }
      clearOverride()
    }
    const handleChange = (event: Event) => {
      if (
        event.target instanceof HTMLElement
        && event.target.dataset.screenpilotTranslationMethod === 'true'
      ) clearOverride()
    }
    const promptCaretSyncs = new Map<HTMLInputElement, () => void>()
    const handlePromptCaretEvent = (event: Event) => {
      if (!isVisionPromptInput(event.target)) return
      promptCaretSyncs.get(event.target)?.()
      promptCaretSyncs.set(event.target, scheduleVisionPromptCaretSync(event.target))
    }
    adapterRoot.addEventListener('input', handleInput)
    adapterRoot.addEventListener('change', handleChange)
    adapterRoot.addEventListener('input', handlePromptCaretEvent)
    adapterRoot.addEventListener('compositionend', handlePromptCaretEvent)
    adapterRoot.addEventListener('paste', handlePromptCaretEvent)
    window.addEventListener('resize', applyAdapters)
    window.addEventListener('screenpilot-ai-availability', applyAdapters)
    window.addEventListener('screenpilot:vision-contract-change', applyAdapters)
    return () => {
      observer.disconnect()
      if (adapterFrame !== null) window.cancelAnimationFrame(adapterFrame)
      adapterFrame = null
      adapterRoot.removeEventListener('input', handleInput)
      adapterRoot.removeEventListener('change', handleChange)
      adapterRoot.removeEventListener('input', handlePromptCaretEvent)
      adapterRoot.removeEventListener('compositionend', handlePromptCaretEvent)
      adapterRoot.removeEventListener('paste', handlePromptCaretEvent)
      promptCaretSyncs.forEach((cancel) => cancel())
      promptCaretSyncs.clear()
      window.removeEventListener('resize', applyAdapters)
      window.removeEventListener('screenpilot-ai-availability', applyAdapters)
      window.removeEventListener('screenpilot:vision-contract-change', applyAdapters)
      adapterRoot.querySelectorAll<HTMLElement>('[data-screenpilot-vision-prompt-preview="true"]').forEach((card) => {
        clearCssProperty(card, '--screenpilot-dialog-initial-height')
        clearFloatingDialogLayout(card)
      })
      adapterRoot.querySelectorAll<HTMLElement>('[data-screenpilot-answer-panel="true"]').forEach((card) => {
        clearCssProperty(card, '--screenpilot-dialog-initial-height')
      })
      document.documentElement.removeAttribute('data-screenpilot-floating-translate-window')
      document.documentElement.removeAttribute('data-screenpilot-floating-translate-pending')
      adapterRoot.querySelectorAll<HTMLElement>('[data-screenpilot-floating-translate-surface="true"]').forEach((card) => {
        card.removeAttribute('data-screenpilot-floating-translate-surface')
      })
      languageHost.remove()
      sourceLanguageHost.remove()
      targetActionsHost.remove()
      resultHost.remove()
    }
  }, [clearOverride, languageSaveError, overrideResult.status, t.send])

  useEffect(() => {
    const body = adapterRootRef.current?.querySelector<HTMLElement>('[data-screenpilot-translation-body="true"]') ?? null
    if (body === null) return
    if (overrideResult.status === 'idle' && languageSaveError === null) {
      delete body.dataset.screenpilotTranslationOverride
    }
    else body.dataset.screenpilotTranslationOverride = 'true'
    setAttributeIfChanged(body, 'aria-busy', overrideResult.status === 'loading' ? 'true' : 'false')
    return () => {
      delete body.dataset.screenpilotTranslationOverride
      body.removeAttribute('aria-busy')
    }
  }, [languageSaveError, overrideResult.status])

  const drainLanguageSaves = useCallback(async () => {
    const flow = languageFlowRef.current
    if (flow.saving) return
    flow.saving = true
    try {
      let continueSaving = true
      while (continueSaving) {
        if (flow.desired.source === flow.confirmed.source
          && flow.desired.target === flow.confirmed.target) {
          continueSaving = false
          continue
        }
        const field: LanguageField = flow.desired.source !== flow.confirmed.source ? 'source' : 'target'
        const value = flow.desired[field]
        const version = flow.fieldVersions[field]
        const epoch = flow.epoch
        try {
          await invoke<ReferenceSettings>('screenshot_translation_settings_update', {
            patch: field === 'source'
              ? { sourceLanguage: value }
              : { targetLanguage: value },
          })
        } catch (error) {
          const isCurrent = epoch === flow.epoch
            && version === flow.fieldVersions[field]
            && flow.desired[field] === value
          if (isCurrent) {
            const rollback = flow.confirmed[field]
            flow.desired[field] = rollback
            if (field === 'source') {
              sourceLanguageRef.current = rollback
              if (mountedRef.current) setSourceLanguage(rollback)
            } else {
              targetLanguageRef.current = rollback
              if (mountedRef.current) setTargetLanguage(rollback)
            }
            if (mountedRef.current) {
              const detail = error instanceof Error ? error.message : String(error)
              setLanguageSaveError(`${t.languageSaveFailed}：${detail}`)
            }
          }
          continue
        }
        if (epoch !== flow.epoch) continue
        // The response is authoritative for this field even if a newer choice
        // is already waiting. The newer desired value remains queued and will
        // be persisted by the next loop iteration.
        flow.confirmed[field] = value
      }
    } finally {
      flow.saving = false
    }
  }, [t.languageSaveFailed])

  const requestLanguageSave = useCallback((field: LanguageField, value: TargetLanguage) => {
    const flow = languageFlowRef.current
    flow.desired[field] = value
    flow.fieldVersions[field] += 1
    if (mountedRef.current) setLanguageSaveError(null)
    const scheduled = flow.queue.then(() => drainLanguageSaves())
    flow.queue = scheduled.catch(() => undefined)
    return scheduled
  }, [drainLanguageSaves])

  const translateVisibleSource = useCallback(async (
    source: string,
    nextSourceLanguage: SourceLanguage,
    nextTargetLanguage: TargetLanguage,
  ): Promise<TranslateResult | null> => {
    if (!source) return null
    return invoke<TranslateResult>('vision_translate_text', {
      text: source,
      sourceLanguage: nextSourceLanguage,
      targetLanguage: nextTargetLanguage,
    })
  }, [])

  const setOverrideState = useCallback((next: OverrideResult) => {
    overrideResultRef.current = next
    setOverrideResult(next)
  }, [])

  const beginOverrideTranslation = useCallback((source: string) => {
    const previousText = overrideResultRef.current.text.trim() || visibleNativeTranslation(adapterRootRef.current)
    const next: OverrideResult = source
      ? { status: 'loading', text: previousText, stale: previousText.length > 0 }
      : { status: 'idle', text: '', stale: false }
    setOverrideState(next)
    return previousText
  }, [setOverrideState])

  const handleSourceLanguage = useCallback(async (value: SourceLanguage) => {
    overrideLockedRef.current = true
    sourceLanguageRef.current = value
    setSourceLanguage(value)
    const source = visibleOcrSource(adapterRootRef.current) || sourceRef.current.text.trim()
    const sequence = requestSequenceRef.current + 1
    requestSequenceRef.current = sequence
    const previousText = beginOverrideTranslation(source)
    try {
      await invoke('vision_cancel_stream').catch(() => undefined)
      const [, translation] = await Promise.all([
        requestLanguageSave('source', value),
        translateVisibleSource(source, value, targetLanguageRef.current),
      ])
      if (sequence !== requestSequenceRef.current || translation === null) return
      if (translation.cancelled) {
        setOverrideState({ status: 'idle', text: '', stale: false })
      } else if (translation.success) {
        setOverrideState({ status: 'ready', text: translation.translated ?? '', stale: false })
      } else {
        setOverrideState({
          status: 'error',
          text: previousText,
          error: translation.error ?? t.translationFailed,
          stale: previousText.length > 0,
        })
      }
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return
      setOverrideState({
        status: 'error',
        text: previousText,
        error: error instanceof Error ? error.message : String(error),
        stale: previousText.length > 0,
      })
    }
  }, [beginOverrideTranslation, requestLanguageSave, setOverrideState, t.translationFailed, translateVisibleSource])

  const handleTargetLanguage = useCallback(async (value: TargetLanguage) => {
    overrideLockedRef.current = true
    targetLanguageRef.current = value
    setTargetLanguage(value)
    const source = visibleOcrSource(adapterRootRef.current) || sourceRef.current.text.trim()
    const sequence = requestSequenceRef.current + 1
    requestSequenceRef.current = sequence
    const previousText = beginOverrideTranslation(source)
    try {
      await invoke('vision_cancel_stream').catch(() => undefined)
      const translation = translateVisibleSource(source, sourceLanguageRef.current, value)
      const [, result] = await Promise.all([
        requestLanguageSave('target', value),
        translation,
      ])
      if (sequence !== requestSequenceRef.current || result === null) return
      if (result.cancelled) {
        setOverrideState({ status: 'idle', text: '', stale: false })
      } else if (result.success) {
        setOverrideState({ status: 'ready', text: result.translated ?? '', stale: false })
      } else {
        setOverrideState({
          status: 'error',
          text: previousText,
          error: result.error ?? t.translationFailed,
          stale: previousText.length > 0,
        })
      }
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return
      setOverrideState({
        status: 'error',
        text: previousText,
        error: error instanceof Error ? error.message : String(error),
        stale: previousText.length > 0,
      })
    }
  }, [beginOverrideTranslation, requestLanguageSave, setOverrideState, t.translationFailed, translateVisibleSource])

  return (
    <main ref={adapterRootRef} data-screenpilot-vision-adapter="true">
      <ReferenceVision knowledgeUi={karakeepVisionUi} />
      {createPortal(
        <span className="screenpilot-source-language-control">
          <label htmlFor="screenpilot-source-language">{t.sourceLanguage}</label>
          <select
            id="screenpilot-source-language"
            aria-label={t.sourceLanguage}
            data-screenpilot-source-language-select="true"
            value={sourceLanguage}
            onChange={(event) => void handleSourceLanguage(event.target.value as SourceLanguage)}
          >
            {sourceLanguageOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </span>,
        sourceLanguageHost,
      )}
      {createPortal(
        <span className="screenpilot-target-language-control">
          <label htmlFor="screenpilot-target-language">{t.targetLanguage}</label>
          <select
            id="screenpilot-target-language"
            aria-label={t.targetLanguage}
            value={targetLanguage}
            onChange={(event) => void handleTargetLanguage(event.target.value as TargetLanguage)}
          >
            {targetLanguageOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </span>,
        languageHost,
      )}
      {createPortal(
        <TranslationOverrideActions
          key={`${overrideResult.status}:${overrideResult.text}`}
          text={overrideResult.text}
          loading={overrideResult.status === 'loading'}
          lang={interfaceLanguage}
        />,
        targetActionsHost,
      )}
      {createPortal(
        overrideResult.status === 'idle' && languageSaveError === null ? null : (
          <>
            {languageSaveError === null ? null : (
              <div
                role="alert"
                aria-live="assertive"
                className="screenpilot-target-result screenpilot-target-result-error screenpilot-language-save-error"
              >
                {languageSaveError}
              </div>
            )}
            {overrideResult.status === 'idle' ? null : (
              <>
                {overrideResult.status === 'loading' ? (
                  <div role="status" aria-live="polite" className="screenpilot-target-result screenpilot-target-result-status">
                    {t.translatingToTarget}
                  </div>
                ) : null}
                {overrideResult.error ? (
                  <div
                    role="alert"
                    aria-live="assertive"
                    aria-label={`${t.translationFailed}: ${overrideResult.error}`}
                    className="screenpilot-target-result screenpilot-target-result-error"
                  >
                    <span>{t.translationFailed}: </span>
                    <span>{overrideResult.error}</span>
                  </div>
                ) : null}
                {overrideResult.text ? (
                  <div
                    data-screenpilot-translation-override-result="true"
                    data-screenpilot-translation-stale={overrideResult.stale ? 'true' : 'false'}
                    aria-live="polite"
                    className="screenpilot-target-result vision-readable-text"
                  >
                    {overrideResult.stale ? (
                      <div className="screenpilot-target-result-stale" role="status">
                        {t.translationPreviousResult}
                      </div>
                    ) : null}
                    <MarkdownView content={overrideResult.text} />
                  </div>
                ) : null}
              </>
            )}
          </>
        ),
        resultHost,
      )}
    </main>
  )
}
