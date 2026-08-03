import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReferenceVision from '../../vendor/kivio-screenshot/Vision'
import '../../vendor/kivio-screenshot/index.css'
import './vision-adapter.css'
import { installOcrDebounceTimingAdapter } from './ocr-debounce-adapter'

type TargetLanguage = 'auto' | 'zh-CN' | 'en' | 'ja' | 'ko'
type SourceLanguage = TargetLanguage

type ReferenceSettings = {
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
  translated?: string
  error?: string
}

type TranslateStreamPayload = {
  imageId?: string
  kind?: 'original' | 'translated'
  delta?: string
  done?: boolean
}

type OverrideResult = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  text: string
}

const targetLanguageOptions: { value: TargetLanguage; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]
const sourceLanguageOptions: { value: SourceLanguage; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

const languageHost = document.createElement('span')
const sourceLanguageHost = document.createElement('span')
const resultHost = document.createElement('div')
const settledTranslateCards = new WeakSet<HTMLElement>()
const requestedTranslateHeights = new WeakMap<HTMLElement, number>()
const OCR_FLOATING_MAX_HEIGHT = 400
languageHost.dataset.screenpilotTargetLanguage = 'true'
sourceLanguageHost.dataset.screenpilotSourceLanguage = 'true'
resultHost.dataset.screenpilotTargetResult = 'true'

function isTargetLanguage(value: unknown): value is TargetLanguage {
  return targetLanguageOptions.some((option) => option.value === value)
}

function findTranslationMethodSelect(): HTMLSelectElement | null {
  return Array.from(document.querySelectorAll<HTMLSelectElement>('select')).find((select) => (
    select.querySelector('option[value="microsoft"]') !== null
    && select.querySelector('option[value="google"]') !== null
  )) ?? null
}

function visibleOcrSource(): string {
  const source = document.querySelector<HTMLElement>('.ocr-editable, .ocr-markdown')
  return source?.innerText.trim() ?? ''
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

function isFloatingResultSurface(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.left >= -2
    && rect.left <= 24
    && Math.abs(rect.right - window.innerWidth) <= 24
    && rect.width >= window.innerWidth - 24
    && window.innerHeight > 96
}

function syncFloatingResultLayout(
  element: HTMLElement,
  height: number,
  floatingSurface: HTMLElement = element,
) {
  if (!isFloatingResultSurface(floatingSurface)) {
    element.removeAttribute('data-screenpilot-floating-answer-card')
    clearCssProperty(element, '--screenpilot-floating-result-height')
    return
  }

  setAttributeIfChanged(element, 'data-screenpilot-floating-answer-card', 'true')
  setCssPropertyIfChanged(element, '--screenpilot-floating-result-height', `${String(Math.max(1, Math.floor(height)))}px`)
}

export default function ReferenceVisionAdapter() {
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>('auto')
  const [targetLanguage, setTargetLanguage] = useState<TargetLanguage>('auto')
  const [overrideResult, setOverrideResult] = useState<OverrideResult>({ status: 'idle', text: '' })
  const sourceRef = useRef({ imageId: '', text: '' })
  const requestSequenceRef = useRef(0)
  const sourceLanguageRef = useRef<SourceLanguage>('auto')
  const targetLanguageRef = useRef<TargetLanguage>('auto')
  const overrideLockedRef = useRef(false)
  const aiAvailabilityRef = useRef({ ocr: true, translation: true })
  const aiAvailabilityLoadedRef = useRef(false)

  useEffect(() => installOcrDebounceTimingAdapter(), [])

  const clearOverride = useCallback(() => {
    overrideLockedRef.current = false
    requestSequenceRef.current += 1
    setOverrideResult({ status: 'idle', text: '' })
  }, [])

  useEffect(() => {
    let active = true
    void invoke<ReferenceSettings>('get_settings').then((settings) => {
      const configuredSource = settings.screenshotTranslation.sourceLanguage
      if (active && isTargetLanguage(configuredSource)) {
        sourceLanguageRef.current = configuredSource
        setSourceLanguage(configuredSource)
      }
      const configured = settings.screenshotTranslation.targetLanguage
      if (active && isTargetLanguage(configured)) {
        targetLanguageRef.current = configured
        setTargetLanguage(configured)
      }
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
      aiAvailabilityRef.current = { ocr: false, translation: false }
      aiAvailabilityLoadedRef.current = true
      window.dispatchEvent(new Event('screenpilot-ai-availability'))
      console.error('Failed to load screenshot target language', error)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let dispose: (() => void) | undefined
    let active = true
    void listen<TranslateStreamPayload>('vision-translate-stream', ({ payload }) => {
      if (payload.kind !== 'original' || !payload.delta) return
      const imageId = payload.imageId ?? ''
      sourceRef.current = {
        imageId,
        text: payload.delta,
      }
      if (!overrideLockedRef.current) clearOverride()
    }).then((unlisten) => {
      if (active) dispose = unlisten
      else unlisten()
    }).catch((error: unknown) => console.error('Failed to observe screenshot translation', error))
    return () => {
      active = false
      dispose?.()
    }
  }, [clearOverride])

  useEffect(() => {
    const applyAdapters = () => {
      const send = document.querySelector<HTMLButtonElement>('button:has(svg.lucide-arrow-up)')
      if (send !== null) send.setAttribute('aria-label', '发送')

      const prompt = document.querySelector<HTMLInputElement>('input[placeholder="问点什么..."], input[placeholder="Ask anything..."]')
      const promptBar = prompt?.parentElement
      const promptPanel = promptBar?.parentElement
      if (promptBar instanceof HTMLElement) {
        setAttributeIfChanged(promptBar, 'data-screenpilot-prompt-bar', 'true')
        setAttributeIfChanged(promptBar, 'data-screenpilot-window-frame', 'true')
        if (promptPanel instanceof HTMLElement) {
          const hasScreenshotThumb = promptBar.querySelector('img[alt="snap"]') !== null
          const isReadyBar = promptBar.classList.contains('cursor-move')
          setAttributeIfChanged(promptPanel, 'data-screenpilot-prompt-panel', 'true')
          setBooleanAttribute(promptPanel, 'data-screenpilot-ready-prompt-panel', isReadyBar || hasScreenshotThumb)
          setBooleanAttribute(promptPanel, 'data-screenpilot-captured-prompt-panel', hasScreenshotThumb)
        }
      }
      if (promptPanel instanceof HTMLElement) {
        const answerCard = Array.from(promptPanel.children).find((child) => (
          child instanceof HTMLElement
          && child.classList.contains('window-frosted')
          && child.classList.contains('transition-all')
          && child.classList.contains('absolute')
        ))
        if (answerCard instanceof HTMLElement) {
          const top = answerCard.getBoundingClientRect().top
          syncFloatingResultLayout(
            answerCard,
            window.innerHeight - top,
            promptPanel,
          )
        } else {
          document.querySelectorAll<HTMLElement>('[data-screenpilot-floating-answer-card="true"]').forEach((card) => {
            card.removeAttribute('data-screenpilot-floating-answer-card')
            clearCssProperty(card, '--screenpilot-floating-result-height')
          })
        }
      } else {
        document.querySelectorAll<HTMLElement>('[data-screenpilot-floating-answer-card="true"]').forEach((card) => {
          card.removeAttribute('data-screenpilot-floating-answer-card')
          clearCssProperty(card, '--screenpilot-floating-result-height')
        })
      }

      const methodSelect = findTranslationMethodSelect()
      const availability = aiAvailabilityRef.current
      document.querySelectorAll<HTMLSelectElement>('select').forEach((select) => {
        const ocr = select.querySelector('option[value="chaoxing"]') !== null
        const translation = select.querySelector('option[value="microsoft"]') !== null
          && select.querySelector('option[value="google"]') !== null
        const allowed = !aiAvailabilityLoadedRef.current
          || (ocr ? availability.ocr : translation ? availability.translation : true)
        if (!allowed) {
          select.querySelector('option[value="ai"]')?.remove()
          if (select.value === 'ai') {
            select.value = ocr ? 'chaoxing' : 'microsoft'
            select.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
      })
      const heading = methodSelect?.parentElement
      const body = heading?.parentElement
      if (methodSelect === null || heading === undefined || heading === null || body === undefined || body === null) {
        document.documentElement.removeAttribute('data-screenpilot-floating-translate-window')
        document.documentElement.removeAttribute('data-screenpilot-floating-translate-pending')
        document.querySelectorAll<HTMLElement>('[data-screenpilot-floating-translate-surface="true"]').forEach((card) => {
          card.removeAttribute('data-screenpilot-floating-translate-surface')
        })
        return
      }
      const divider = heading.previousElementSibling
      const source = divider?.previousElementSibling
      const sourceHeading = source instanceof HTMLElement
        ? source.firstElementChild instanceof HTMLElement ? source.firstElementChild : null
        : null
      const sourceMethodSelect = sourceHeading?.querySelector<HTMLSelectElement>(
        'select:not([data-screenpilot-source-language-select="true"])',
      ) ?? null
      body.dataset.screenpilotTranslationBody = 'true'
      const translateCard = body.parentElement
      translateCard?.setAttribute('data-screenpilot-window-frame', 'true')
      const translateRect = translateCard instanceof HTMLElement
        ? translateCard.getBoundingClientRect()
        : null
      const floatingTranslateSurface = translateCard instanceof HTMLElement
        && isFloatingResultSurface(translateCard)
      const floatingTranslateMatchesViewport = floatingTranslateSurface
        && translateRect !== null
        && Math.abs(window.innerHeight - translateRect.height) <= 12
      if (translateCard instanceof HTMLElement && floatingTranslateMatchesViewport) {
        settledTranslateCards.add(translateCard)
      }
      const floatingTranslateSettled = floatingTranslateSurface
        && translateCard instanceof HTMLElement
        && settledTranslateCards.has(translateCard)
      if (floatingTranslateSurface && translateCard instanceof HTMLElement) {
        const header = translateCard.firstElementChild
        const headerHeight = header instanceof HTMLElement ? header.getBoundingClientRect().height : 0
        const desiredHeight = Math.min(
          OCR_FLOATING_MAX_HEIGHT,
          Math.ceil(headerHeight + body.scrollHeight),
        )
        if (translateRect !== null && desiredHeight > translateRect.height + 1) {
          if (requestedTranslateHeights.get(translateCard) !== desiredHeight) {
            requestedTranslateHeights.set(translateCard, desiredHeight)
            void invoke('vision_set_floating', {
              rect: { width: Math.ceil(translateRect.width), height: desiredHeight },
            }).catch((error: unknown) => console.error('Failed to expand screenshot translation window', error))
          }
        } else {
          requestedTranslateHeights.delete(translateCard)
        }
      }
      if (translateCard instanceof HTMLElement) {
        setBooleanAttribute(
          translateCard,
          'data-screenpilot-floating-translate-surface',
          floatingTranslateSurface,
        )
        setBooleanAttribute(
          translateCard,
          'data-screenpilot-floating-translate-card',
          floatingTranslateSettled,
        )
      }
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
      if (source instanceof HTMLElement && source.querySelector('.ocr-editable, .ocr-markdown') !== null) {
        const reachedHeightLimit = floatingTranslateSettled
          && window.innerHeight >= OCR_FLOATING_MAX_HEIGHT - 1
        if (reachedHeightLimit) {
          const sourceHeight = Math.max(92, Math.floor(body.getBoundingClientRect().height * 0.42))
          source.dataset.screenpilotOcrSource = 'true'
          setCssPropertyIfChanged(source, '--screenpilot-ocr-source-max-height', `${String(sourceHeight)}px`)
        } else {
          source.removeAttribute('data-screenpilot-ocr-source')
          clearCssProperty(source, '--screenpilot-ocr-source-max-height')
        }
      }
      heading.dataset.screenpilotTranslatedHeading = 'true'
      methodSelect.dataset.screenpilotTranslationMethod = 'true'
      if (sourceHeading !== null) {
        sourceHeading.dataset.screenpilotOriginalHeading = 'true'
        if (
          sourceLanguageHost.parentElement !== sourceHeading
          || sourceLanguageHost.nextSibling !== sourceMethodSelect
        ) {
          sourceHeading.insertBefore(sourceLanguageHost, sourceMethodSelect)
        }
      }
      if (languageHost.parentElement !== heading || languageHost.nextSibling !== methodSelect) {
        heading.insertBefore(languageHost, methodSelect)
      }
      if (resultHost.parentElement !== body || heading.nextSibling !== resultHost) {
        heading.after(resultHost)
      }
    }

    applyAdapters()
    const observer = new MutationObserver(applyAdapters)
    observer.observe(document.body, {
      attributeFilter: ['class', 'style'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    const handleInput = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.classList.contains('ocr-editable')) return
      sourceRef.current = { imageId: sourceRef.current.imageId, text: target.innerText }
      clearOverride()
    }
    const handleChange = (event: Event) => {
      if (event.target === findTranslationMethodSelect()) clearOverride()
    }
    document.addEventListener('input', handleInput)
    document.addEventListener('change', handleChange)
    window.addEventListener('resize', applyAdapters)
    window.addEventListener('screenpilot-ai-availability', applyAdapters)
    return () => {
      observer.disconnect()
      document.removeEventListener('input', handleInput)
      document.removeEventListener('change', handleChange)
      window.removeEventListener('resize', applyAdapters)
      window.removeEventListener('screenpilot-ai-availability', applyAdapters)
      document.documentElement.removeAttribute('data-screenpilot-floating-translate-window')
      document.documentElement.removeAttribute('data-screenpilot-floating-translate-pending')
      document.querySelectorAll<HTMLElement>('[data-screenpilot-floating-translate-surface="true"]').forEach((card) => {
        card.removeAttribute('data-screenpilot-floating-translate-surface')
      })
      languageHost.remove()
      sourceLanguageHost.remove()
      resultHost.remove()
    }
  }, [clearOverride])

  useEffect(() => {
    const body = resultHost.parentElement
    if (body === null) return
    if (overrideResult.status === 'idle') delete body.dataset.screenpilotTranslationOverride
    else body.dataset.screenpilotTranslationOverride = 'true'
    return () => {
      delete body.dataset.screenpilotTranslationOverride
    }
  }, [overrideResult.status])

  const persistTargetLanguage = useCallback(async (value: TargetLanguage, source: SourceLanguage) => {
    const settings = await invoke<ReferenceSettings>('get_settings')
    await invoke('save_settings', {
      settings: {
        ...settings,
        screenshotTranslation: {
          ...settings.screenshotTranslation,
          sourceLanguage: source,
          targetLanguage: value,
        },
      },
    })
  }, [])

  const persistSourceLanguage = useCallback(async (value: SourceLanguage, target: TargetLanguage) => {
    const settings = await invoke<ReferenceSettings>('get_settings')
    await invoke('save_settings', {
      settings: {
        ...settings,
        screenshotTranslation: {
          ...settings.screenshotTranslation,
          targetLanguage: target,
          sourceLanguage: value,
        },
      },
    })
  }, [])

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

  const handleSourceLanguage = useCallback(async (value: SourceLanguage) => {
    overrideLockedRef.current = true
    sourceLanguageRef.current = value
    setSourceLanguage(value)
    const source = visibleOcrSource() || sourceRef.current.text.trim()
    const sequence = requestSequenceRef.current + 1
    requestSequenceRef.current = sequence
    if (source) setOverrideResult({ status: 'loading', text: '' })
    else setOverrideResult({ status: 'idle', text: '' })
    try {
      await invoke('vision_cancel_stream').catch(() => undefined)
      const [, translation] = await Promise.all([
        persistSourceLanguage(value, targetLanguageRef.current),
        translateVisibleSource(source, value, targetLanguageRef.current),
      ])
      if (sequence !== requestSequenceRef.current || translation === null) return
      if (translation.success) {
        setOverrideResult({ status: 'ready', text: translation.translated ?? '' })
      } else {
        setOverrideResult({ status: 'error', text: translation.error ?? '翻译失败' })
      }
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return
      setOverrideResult({
        status: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }, [persistSourceLanguage, translateVisibleSource])

  const handleTargetLanguage = useCallback(async (value: TargetLanguage) => {
    overrideLockedRef.current = true
    targetLanguageRef.current = value
    setTargetLanguage(value)
    const source = visibleOcrSource() || sourceRef.current.text.trim()
    const sequence = requestSequenceRef.current + 1
    requestSequenceRef.current = sequence
    if (source) setOverrideResult({ status: 'loading', text: '' })
    else setOverrideResult({ status: 'idle', text: '' })
    try {
      await invoke('vision_cancel_stream').catch(() => undefined)
      const translation = translateVisibleSource(source, sourceLanguageRef.current, value)
      const [, result] = await Promise.all([
        persistTargetLanguage(value, sourceLanguageRef.current),
        translation,
      ])
      if (sequence !== requestSequenceRef.current || result === null) return
      if (result.success) {
        setOverrideResult({ status: 'ready', text: result.translated ?? '' })
      } else {
        setOverrideResult({ status: 'error', text: result.error ?? '翻译失败' })
      }
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return
      setOverrideResult({
        status: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }, [persistTargetLanguage, translateVisibleSource])

  return (
    <main data-screenpilot-vision-adapter="true">
      <ReferenceVision />
      {createPortal(
        <span className="screenpilot-source-language-control">
          <label htmlFor="screenpilot-source-language">源语言</label>
          <select
            id="screenpilot-source-language"
            aria-label="源语言"
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
          <label htmlFor="screenpilot-target-language">目标语言</label>
          <select
            id="screenpilot-target-language"
            aria-label="目标语言"
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
        overrideResult.status === 'idle' ? null : (
          <div
            aria-live="polite"
            className={overrideResult.status === 'error'
              ? 'screenpilot-target-result screenpilot-target-result-error'
              : 'screenpilot-target-result vision-readable-text'}
          >
            {overrideResult.status === 'loading' ? '正在按目标语言翻译…' : overrideResult.text}
          </div>
        ),
        resultHost,
      )}
    </main>
  )
}
