import type { Page } from '@playwright/test'

const sampleImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#f1f3f4"/><rect x="80" y="90" width="800" height="360" rx="24" fill="#ffffff" stroke="#d9dddf"/><text x="130" y="180" font-family="Segoe UI" font-size="44" fill="#171a1d">ScreenPilot Visual Test</text><text x="130" y="250" font-family="Segoe UI" font-size="28" fill="#4e565c">可见内容识别 · English OCR · E = mc²</text><rect x="130" y="310" width="520" height="18" rx="9" fill="#c35e42"/></svg>',
)}`

export async function installVisionTauriMock(
  page: Page,
  ocrSource = 'ScreenPilot Visual Test\n可见内容识别 · English OCR · E = mc²',
  keepFullscreenAfterCapture = true,
  translatedText = 'ScreenPilot 视觉测试\n可见内容识别、英文 OCR 与公式 E = mc²',
  visionStreamDelayMs = 0,
  deferFloatingSetResponses = 0,
  nativeResizeClientWidthDelta = 0,
  archiveWarning = '',
  directTranslate = false,
  listenerFailures: Partial<Record<'vision-stream' | 'vision-translate-stream', number>> = {},
  initialTranslationMethod: 'ai' | 'google' | 'baidu' | 'tencent' | 'bing' | 'bing2' | 'yandex' | 'caiyun2' | 'microsoft' = 'microsoft',
): Promise<void> {
  await page.addInitScript(({ image, sourceText, keepFullscreen, translatedResult, streamDelayMs, deferSetResponses, nativeWidthDelta, archiveWarningText, directTranslateEnabled, initialListenerFailures, initialMethod }) => {
    const callbacks = new Map<number, (payload: unknown) => void>()
    const listeners = new Map<string, Map<number, number>>()
    const listenerTargets = new Map<number, { kind: string; label?: string }>()
    const windowLabel = new URLSearchParams(window.location.search).get('window') ?? 'vision'
    let callbackSequence = 0
    let listenerSequence = 0
    let imageSequence = 0
    let nativeResizeFeedbackFlip = false
    let nativeResizeFeedbackCount = 0
    let nativeResizeFeedbackBaseWidth: number | null = null
    type CaptureResult = {
      success: boolean
      imageId?: string
      error?: string
      archiveWarning?: string
    }
    const pendingCaptureResolvers: ((result: CaptureResult) => void)[] = []
    const pendingShowResolvers: (() => void)[] = []
    const pendingVisionFlightResolvers: (() => void)[] = []
    const pendingVisionCloseResolvers: (() => void)[] = []
    const floatingPadding = 8
    const floatingInset = floatingPadding * 2
    const visionTestState = {
      showCount: 0,
      emitWindowEvent: (label: string, event: string, payload: unknown): void => {
        void label
        void event
        void payload
      },
      translationRequests: [] as { text: string; sourceLanguage: string; targetLanguage: string; method: string }[],
      translationMethodUpdates: [] as string[],
      translationSettingsDelayMs: 0,
      translationSettingsFailuresRemaining: 0,
      translationResponseDelayMs: 0,
      externalUrls: [] as string[],
      answerText: 'The image contains a synthetic ScreenPilot visual test with Chinese, English, and a formula.',
      activeVisionImageId: '',
      activeVisionRequestId: '',
      floatingRect: null as { width: number; height: number } | null,
      floatingRects: [] as { width: number; height: number }[],
      visionFlights: [] as {
        from: { x: number; y: number }
        to: { x: number; y: number }
        width: number
        height: number
        hasScreenshot: boolean
        durationMs: number
      }[],
      deferVisionFlights: false,
      visionFlightFailuresRemaining: 0,
      completedVisionFlightCount: 0,
      pendingVisionFlightCount: 0,
      resolveNextVisionFlight: () => false,
      floatingAppliedRects: [] as { width: number; height: number }[],
      floatingDeferredRects: [] as { width: number; height: number }[],
      floatingHitRegion: null as { x: number; y: number; width: number; height: number } | null,
      floatingHitRegionHistory: [] as ({ x: number; y: number; width: number; height: number } | null)[],
      floatingResizable: false,
      floatingHasScreenshot: true,
      floatingMinimumHeight: 0,
      floatingDeferredResponsesRemaining: Math.max(0, deferSetResponses || 0),
      safeDragCalls: 0,
      safeDragRejectsRemaining: 0,
      windowVisible: true,
      deferShow: false,
      pendingShowCount: 0,
      resolveNextShow: () => false,
      hideCount: 0,
      deferCapture: false,
      pendingCaptureCount: 0,
      resolveNextCapture: (success?: boolean) => {
        void success
        return false
      },
      closeVisionSurface: () => undefined,
      closeCalls: 0,
      closeFailuresRemaining: 0,
      deferVisionClose: false,
      pendingVisionCloseCount: 0,
      resolveNextVisionClose: () => false,
      listenerFailuresRemaining: { ...initialListenerFailures } as Partial<Record<string, number>>,
      listenerAttempts: {} as Record<string, number>,
      visionAskCalls: 0,
      visionTranslateCalls: 0,
      visionTranslateGeneration: 0,
      visionTranslateRequests: [] as { imageId: string; requestId: string; generation: number }[],
      visionTranslateOcrFailuresRemaining: 0,
      visionTranslateTranslationFailuresRemaining: 0,
      visionTranslateTextFailuresRemaining: 0,
      suppressVisionTranslateEvents: false,
      emitVisionTranslatePayload: (payload: unknown) => {
        void payload
        return false
      },
      emitVisionAnswerDelta: (delta: string) => {
        void delta
        return false
      },
      interfaceLanguage: 'zh' as 'zh' | 'en',
      temporaryImageIds: [] as string[],
      committedImageIds: [] as string[],
      deletedTemporaryImageIds: [] as string[],
      speechCalls: 0,
      speechFailuresRemaining: 0,
    }
    const settings = {
      hotkey: 'F2',
      theme: 'light',
      targetLang: 'zh',
      source: 'auto',
      autoPaste: true,
      launchAtStartup: false,
      launchAtStartupAsAdmin: false,
      translatorProviderId: 'test-provider',
      translatorModel: 'test-model',
      translationAiEnabled: true,
      translatorPrompt: '',
      providers: [{
        id: 'test-provider',
        name: 'Synthetic Provider',
        keyCount: 1,
        baseUrl: 'https://example.invalid/v1',
        availableModels: ['test-model'],
        enabledModels: ['test-model'],
      }],
      retryEnabled: true,
      retryAttempts: 3,
      screenshotTranslation: {
        enabled: true,
        sourceLanguage: 'auto',
        targetLanguage: 'auto',
        hotkey: 'F4',
        providerId: 'test-provider',
        model: 'test-model',
        ocrAiEnabled: true,
        ocrMethod: 'chaoxing',
        translationMethod: initialMethod,
        translationAiEnabled: true,
        translateProviderId: 'test-provider',
        translateModel: 'test-model',
        baiduOcr: { apiKeyConfigured: true, secretKeyConfigured: true },
        baiduTranslate: { appIdConfigured: true, appKeyConfigured: true },
        tencentTranslate: { secretIdConfigured: true, secretKeyConfigured: true },
        caiyunTranslate: { tokenConfigured: true },
        directTranslate: directTranslateEnabled,
        thinkingEnabled: false,
        thinkingEffort: 'medium',
        streamEnabled: true,
        keepFullscreenAfterCapture: keepFullscreen,
        useSystemOcr: false,
        ocrPrompt: '',
        prompt: '',
      },
      vision: {
        enabled: true,
        hotkey: 'F3',
        providerId: 'test-provider',
        model: 'test-model',
        defaultLanguage: 'zh',
        streamEnabled: true,
        thinkingEnabled: true,
        thinkingEffort: 'medium',
        webSearchEnabled: false,
        systemPrompt: '',
        questionPrompt: '',
        messageOrder: 'asc',
        keepFullscreenAfterCapture: keepFullscreen,
      },
      promptOptimizer: {
        enabled: true,
        hotkey: 'Control+Alt+P',
        providerId: 'test-provider',
        model: 'test-model',
        defaultLanguage: 'zh',
        thinkingEffort: 'medium',
        systemPrompt: '',
        optimizePrompt: '',
      },
      settingsLanguage: 'zh',
      autoCheckUpdate: false,
      imageArchiveEnabled: false,
      imageArchivePath: '',
    }
    const createCaptureSuccess = (): CaptureResult => {
      const imageId = `capture-${++imageSequence}`
      visionTestState.temporaryImageIds.push(imageId)
      return {
        success: true,
        imageId,
        ...(archiveWarningText ? { archiveWarning: archiveWarningText } : {}),
      }
    }
    visionTestState.resolveNextCapture = (success = true) => {
      const resolve = pendingCaptureResolvers.shift()
      visionTestState.pendingCaptureCount = pendingCaptureResolvers.length
      if (!resolve) return false
      resolve(success
        ? createCaptureSuccess()
        : { success: false, error: 'Vision surface is no longer active' })
      return true
    }
    visionTestState.resolveNextShow = () => {
      const resolve = pendingShowResolvers.shift()
      visionTestState.pendingShowCount = pendingShowResolvers.length
      if (!resolve) return false
      visionTestState.windowVisible = true
      resolve()
      return true
    }
    visionTestState.resolveNextVisionFlight = () => {
      const resolve = pendingVisionFlightResolvers.shift()
      visionTestState.pendingVisionFlightCount = pendingVisionFlightResolvers.length
      if (!resolve) return false
      resolve()
      return true
    }
    visionTestState.resolveNextVisionClose = () => {
      const resolve = pendingVisionCloseResolvers.shift()
      visionTestState.pendingVisionCloseCount = pendingVisionCloseResolvers.length
      if (!resolve) return false
      resolve()
      return true
    }
    visionTestState.emitWindowEvent = (label: string, event: string, payload: unknown) => {
      for (const [eventId, callbackId] of listeners.get(event) ?? []) {
        const target = listenerTargets.get(eventId)
        if (target?.kind !== 'Any' && target?.label !== label) continue
        callbacks.get(callbackId)?.({ event, id: eventId, payload })
      }
    }
    const emit = (event: string, payload: unknown) => {
      visionTestState.emitWindowEvent(windowLabel, event, payload)
    }
    visionTestState.emitVisionAnswerDelta = (delta: string) => {
      const eventListeners = listeners.get('vision-stream')
      if (eventListeners === undefined || eventListeners.size === 0) return false
      emit('vision-stream', {
        imageId: visionTestState.activeVisionImageId,
        requestId: visionTestState.activeVisionRequestId,
        kind: 'answer',
        delta,
      })
      return true
    }
    visionTestState.emitVisionTranslatePayload = (payload: unknown) => {
      emit('vision-translate-stream', payload)
      return true
    }
    visionTestState.closeVisionSurface = () => {
      emit('screenpilot:vision-closing', null)
      visionTestState.windowVisible = false
      visionTestState.floatingRect = null
      visionTestState.floatingHitRegion = null
      visionTestState.floatingHitRegionHistory.push(null)
      visionTestState.floatingResizable = false
      visionTestState.floatingHasScreenshot = true
      visionTestState.floatingMinimumHeight = 0
    }
    const unregisterListener = (event: string, eventId: number) => {
      listeners.get(event)?.delete(eventId)
      listenerTargets.delete(eventId)
    }
    const stringArgument = (value: unknown) => typeof value === 'string' ? value : ''
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      await Promise.resolve()
      if (command === 'plugin:event|listen') {
        const event = String(args.event)
        visionTestState.listenerAttempts[event] = (visionTestState.listenerAttempts[event] ?? 0) + 1
        const failuresRemaining: number = Reflect.get(visionTestState.listenerFailuresRemaining, event) ?? 0
        if (failuresRemaining > 0) {
          visionTestState.listenerFailuresRemaining[event] = failuresRemaining - 1
          throw new Error(`synthetic ${event} listener failure`)
        }
        const eventId = ++listenerSequence
        listenerTargets.set(eventId, args.target as { kind: string; label?: string } | undefined ?? { kind: 'Any' })
        const handlers = listeners.get(event) ?? new Map<number, number>()
        handlers.set(eventId, Number(args.handler))
        listeners.set(event, handlers)
        return eventId
      }
      if (command === 'plugin:event|unlisten') {
        unregisterListener(String(args.event), Number(args.eventId))
        return null
      }
      if (command === 'plugin:window|outer_position') return { x: 0, y: 0 }
      if (command === 'plugin:window|inner_position') return { x: 0, y: 0 }
      if (command === 'plugin:window|outer_size') return { width: innerWidth, height: innerHeight }
      if (command === 'plugin:window|inner_size') return { width: innerWidth, height: innerHeight }
      if (command === 'plugin:window|scale_factor') return 1
      if (command === 'plugin:window|is_visible') return visionTestState.windowVisible
      if (command === 'plugin:window|show') {
        visionTestState.showCount += 1
        if (visionTestState.deferShow) {
          return new Promise<void>((resolve) => {
            pendingShowResolvers.push(resolve)
            visionTestState.pendingShowCount = pendingShowResolvers.length
          })
        }
        visionTestState.windowVisible = true
        return null
      }
      if (command === 'plugin:window|hide') {
        visionTestState.hideCount += 1
        visionTestState.windowVisible = false
        return null
      }
      if (command.startsWith('plugin:window|')) return null
      if (command === 'open_external') {
        visionTestState.externalUrls.push(String(args.url))
        return null
      }
      if (command === 'vision_runtime_settings_load') {
        settings.settingsLanguage = visionTestState.interfaceLanguage
        return structuredClone(settings)
      }
      if (command === 'screenshot_translation_settings_update') {
        const patch = args.patch as Partial<typeof settings.screenshotTranslation>
        if (typeof patch.translationMethod === 'string') {
          visionTestState.translationMethodUpdates.push(patch.translationMethod)
        }
        if (visionTestState.translationSettingsDelayMs > 0) {
          await new Promise(resolve => window.setTimeout(resolve, visionTestState.translationSettingsDelayMs))
        }
        if (visionTestState.translationSettingsFailuresRemaining > 0) {
          visionTestState.translationSettingsFailuresRemaining -= 1
          throw new Error('synthetic translation settings failure')
        }
        Object.assign(settings.screenshotTranslation, patch)
        return structuredClone(settings)
      }
      if (command === 'take_vision_selection') return ''
      if (command === 'vision_cursor_position') return { x: 40, y: 40 }
      if (command === 'vision_list_windows') {
        return [{ id: 1, owner: 'Synthetic', title: 'Visual Test', x: 850, y: 80, width: 300, height: 300 }]
      }
      if (command === 'vision_capture_window') {
        return { success: false, error: 'Windows frozen-region fallback' }
      }
      if (command === 'vision_capture_region') {
        if (visionTestState.deferCapture) {
          return new Promise<CaptureResult>((resolve) => {
            pendingCaptureResolvers.push(resolve)
            visionTestState.pendingCaptureCount = pendingCaptureResolvers.length
          })
        }
        return createCaptureSuccess()
      }
      if (command === 'explain_read_image') return { success: true, data: image }
      if (command === 'vision_register_annotated_image') {
        const imageId = `annotated-${++imageSequence}`
        visionTestState.temporaryImageIds.push(imageId)
        return { success: true, imageId }
      }
      if (command === 'vision_ask') {
        visionTestState.visionAskCalls += 1
        const imageId = stringArgument(args.imageId)
        const requestId = stringArgument(args.requestId)
        visionTestState.activeVisionImageId = imageId
        visionTestState.activeVisionRequestId = requestId
        emit('vision-stream', {
          imageId,
          requestId,
          kind: 'answer',
          delta: '',
          reasoningDelta: 'Checking the visible content.',
        })
        emit('vision-stream', {
          imageId,
          requestId,
          kind: 'answer',
          delta: visionTestState.answerText,
        })
        if (streamDelayMs > 0) {
          return new Promise<{ success: boolean; requestId: string }>((resolve) => {
            window.setTimeout(() => {
              emit('vision-stream', { imageId, requestId, kind: 'answer', delta: '', done: true, reason: 'done' })
              resolve({ success: true, requestId })
            }, streamDelayMs)
          })
        }
        emit('vision-stream', { imageId, requestId, kind: 'answer', delta: '', done: true, reason: 'done' })
        return { success: true, requestId }
      }
      if (command === 'vision_translate') {
        visionTestState.visionTranslateCalls += 1
        const generation = ++visionTestState.visionTranslateGeneration
        const imageId = stringArgument(args.imageId)
        const requestId = stringArgument(args.requestId)
        visionTestState.visionTranslateRequests.push({ imageId, requestId, generation })
        const emitTranslation = (payload: unknown) => {
          if (!visionTestState.suppressVisionTranslateEvents) {
            emit('vision-translate-stream', payload)
          }
        }
        if (visionTestState.visionTranslateOcrFailuresRemaining > 0) {
          visionTestState.visionTranslateOcrFailuresRemaining -= 1
          const error = 'synthetic OCR failure'
          emitTranslation({
            imageId,
            requestId,
            generation,
            kind: 'original',
            done: true,
            success: false,
            error,
          })
          return { success: false, requestId, kind: 'original', error }
        }
        emitTranslation({
          imageId,
          requestId,
          generation,
          kind: 'original',
          delta: sourceText,
        })
        if (visionTestState.visionTranslateTranslationFailuresRemaining > 0) {
          visionTestState.visionTranslateTranslationFailuresRemaining -= 1
          const error = 'synthetic translation failure'
          emitTranslation({
            imageId,
            requestId,
            generation,
            kind: 'translated',
            done: true,
            success: false,
            error,
          })
          return { success: false, requestId, kind: 'translated', original: sourceText, error }
        }
        emitTranslation({
          imageId,
          requestId,
          generation,
          kind: 'translated',
          delta: translatedResult,
        })
        emitTranslation({ imageId, requestId, generation, kind: 'translated', done: true, success: true })
        return { success: true, requestId, original: sourceText, translated: translatedResult }
      }
      if (command === 'vision_translate_text') {
        const requestedSource = stringArgument(args.sourceLanguage)
        const requestedTarget = stringArgument(args.targetLanguage)
        const sourceLanguage = requestedSource || settings.screenshotTranslation.sourceLanguage
        const targetLanguage = requestedTarget || settings.screenshotTranslation.targetLanguage
        const text = String(args.text)
        visionTestState.translationRequests.push({
          text,
          sourceLanguage,
          targetLanguage,
          method: settings.screenshotTranslation.translationMethod,
        })
        if (visionTestState.translationResponseDelayMs > 0) {
          await new Promise(resolve => window.setTimeout(resolve, visionTestState.translationResponseDelayMs))
        }
        if (visionTestState.visionTranslateTextFailuresRemaining > 0) {
          visionTestState.visionTranslateTextFailuresRemaining -= 1
          return { success: false, error: 'synthetic translation failure' }
        }
        return { success: true, translated: `编辑后译文(${targetLanguage})：${text}` }
      }
      if (command === 'vision_optimize_prompt') return `明确目标、约束和输出格式：${String(args.text)}`
      if (command === 'synthesize_speech') {
        visionTestState.speechCalls += 1
        if (visionTestState.speechFailuresRemaining > 0) {
          visionTestState.speechFailuresRemaining -= 1
          return { success: false, error: 'synthetic speech failure' }
        }
        return { success: true, data: 'data:audio/wav;base64,UklGRg==' }
      }
      if (command === 'vision_close') {
        visionTestState.closeCalls += 1
        if (visionTestState.deferVisionClose) {
          await new Promise<void>((resolve) => {
            pendingVisionCloseResolvers.push(resolve)
            visionTestState.pendingVisionCloseCount = pendingVisionCloseResolvers.length
          })
        }
        if (visionTestState.closeFailuresRemaining > 0) {
          visionTestState.closeFailuresRemaining -= 1
          emit('screenpilot:vision-closing', null)
          throw new Error('synthetic close failure')
        }
        visionTestState.closeVisionSurface()
        visionTestState.windowVisible = false
        visionTestState.deletedTemporaryImageIds.push(...visionTestState.temporaryImageIds)
        visionTestState.temporaryImageIds = []
        return null
      }
      if (command === 'vision_set_hit_region') {
        const requested = args.rect as {
          x?: unknown
          y?: unknown
          width?: unknown
          height?: unknown
        } | null | undefined
        const valid = requested !== null
          && requested !== undefined
          && Number.isFinite(Number(requested.x))
          && Number.isFinite(Number(requested.y))
          && Number.isFinite(Number(requested.width))
          && Number.isFinite(Number(requested.height))
          && Number(requested.width) > 0
          && Number(requested.height) > 0
        visionTestState.floatingHitRegion = valid
          ? {
              x: Number(requested.x),
              y: Number(requested.y),
              width: Number(requested.width),
              height: Number(requested.height),
            }
          : null
        visionTestState.floatingHitRegionHistory.push(visionTestState.floatingHitRegion)
        return true
      }
      if (command === 'vision_set_floating') {
        const rect = args.rect as {
          x?: unknown
          y?: unknown
          width?: unknown
          height?: unknown
          hasScreenshot?: unknown
        } | undefined
        const screenshotTranslation = location.hash.includes('mode=translate')
        const positionedTranslation = screenshotTranslation
          && Number.isFinite(Number(rect?.x))
          && Number.isFinite(Number(rect?.y))
        const requestedHeight = Number(rect?.height)
        const hasScreenshot = typeof rect?.hasScreenshot === 'boolean'
          ? rect.hasScreenshot
          : true
        const referenceViewportHeight = Math.max(innerHeight, screen.height, screen.availHeight)
        const screenshotDialogHeight = Math.round(
          Math.round(Math.max(220, Math.min(480, referenceViewportHeight * 0.45))) * 2 / 3,
        )
        const dialogHeight = Math.round(screenshotDialogHeight * (hasScreenshot ? 1 : 3 / 2))
        const chatInitialHeight = 56 + 8 + dialogHeight + 2 + floatingInset
        const floatingRect = {
          width: Number(rect?.width),
          height: screenshotTranslation
            ? Math.min(requestedHeight, positionedTranslation ? 224 + floatingInset : 400 + floatingInset)
            : requestedHeight,
        }
        if (!screenshotTranslation && requestedHeight > 96) {
          // Mirrors the Windows command's defensive SetWindowRgn(clear)
          // before accepting a resizable floating geometry.
          visionTestState.floatingHitRegion = null
          visionTestState.floatingHitRegionHistory.push(null)
        }
        visionTestState.floatingRects.push(floatingRect)
        if (nativeWidthDelta !== 0 && !positionedTranslation && nativeResizeFeedbackCount < 24) {
          nativeResizeFeedbackCount += 1
          nativeResizeFeedbackBaseWidth ??= Number(rect?.width)
          const feedbackWidth = nativeResizeFeedbackBaseWidth + (nativeResizeFeedbackFlip ? nativeWidthDelta : 0)
          nativeResizeFeedbackFlip = !nativeResizeFeedbackFlip
          Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: Math.max(1, Math.round(feedbackWidth)),
          })
          window.dispatchEvent(new Event('resize'))
        }
        const positioned = Number.isFinite(Number(rect?.x)) && Number.isFinite(Number(rect?.y))
        const enteringResizable = !screenshotTranslation && requestedHeight > 96 && !visionTestState.floatingResizable
        const modeChanged = hasScreenshot !== visionTestState.floatingHasScreenshot
        if (visionTestState.floatingDeferredResponsesRemaining > 0) {
          visionTestState.floatingDeferredResponsesRemaining -= 1
          visionTestState.floatingDeferredRects.push(floatingRect)
          return false
        }
        const deferred = !screenshotTranslation
          && requestedHeight > 96
          && visionTestState.floatingResizable
          && !positioned
          && !modeChanged
        if (deferred) {
          visionTestState.floatingDeferredRects.push(floatingRect)
          return true
        }
        if (
          enteringResizable
          || (!screenshotTranslation && requestedHeight > 96 && (positioned || modeChanged))
        ) {
          floatingRect.height = chatInitialHeight
          visionTestState.floatingResizable = true
          visionTestState.floatingMinimumHeight = chatInitialHeight
        } else if (!screenshotTranslation && requestedHeight <= 96) {
          visionTestState.floatingResizable = false
          visionTestState.floatingMinimumHeight = 0
        }
        visionTestState.floatingHasScreenshot = hasScreenshot
        visionTestState.floatingRect = floatingRect
        visionTestState.floatingAppliedRects.push(floatingRect)
        return true
      }
      if (command === 'vision_fly_floating') {
        const rect = args.rect as {
          from?: { x?: unknown; y?: unknown }
          to?: { x?: unknown; y?: unknown }
          width?: unknown
          height?: unknown
          hasScreenshot?: unknown
          durationMs?: unknown
        } | undefined
        const requestedHeight = Number(rect?.height)
        const hasScreenshot = typeof rect?.hasScreenshot === 'boolean'
          ? rect.hasScreenshot
          : true
        visionTestState.visionFlights.push({
          from: {
            x: Number(rect?.from?.x),
            y: Number(rect?.from?.y),
          },
          to: {
            x: Number(rect?.to?.x),
            y: Number(rect?.to?.y),
          },
          width: Number(rect?.width),
          height: requestedHeight,
          hasScreenshot,
          durationMs: Number(rect?.durationMs),
        })
        if (!location.hash.includes('mode=translate') && visionTestState.floatingResizable && requestedHeight <= 96) {
          return null
        }
        if (visionTestState.visionFlightFailuresRemaining > 0) {
          visionTestState.visionFlightFailuresRemaining -= 1
          throw new Error('Synthetic Vision floating flight failure')
        }
        visionTestState.floatingHasScreenshot = hasScreenshot
        const floatingRect = {
          width: Number(rect?.width),
          height: location.hash.includes('mode=translate')
            ? Math.min(requestedHeight, 224 + floatingInset)
            : requestedHeight,
        }
        visionTestState.floatingRect = floatingRect
        visionTestState.floatingRects.push(floatingRect)
        visionTestState.floatingAppliedRects.push(floatingRect)
        if (visionTestState.deferVisionFlights) {
          await new Promise<void>((resolve) => {
            pendingVisionFlightResolvers.push(resolve)
            visionTestState.pendingVisionFlightCount = pendingVisionFlightResolvers.length
          })
        }
        visionTestState.completedVisionFlightCount += 1
        return null
      }
      if (command === 'vision_commit_image_to_history') {
        const imageId = stringArgument(args.imageId)
        visionTestState.temporaryImageIds = visionTestState.temporaryImageIds.filter((id) => id !== imageId)
        if (!visionTestState.committedImageIds.includes(imageId)) visionTestState.committedImageIds.push(imageId)
        return null
      }
      if (command === 'vision_delete_temporary_image') {
        const imageId = stringArgument(args.imageId)
        const wasTemporary = visionTestState.temporaryImageIds.includes(imageId)
        visionTestState.temporaryImageIds = visionTestState.temporaryImageIds.filter((id) => id !== imageId)
        if (wasTemporary && !visionTestState.deletedTemporaryImageIds.includes(imageId)) {
          visionTestState.deletedTemporaryImageIds.push(imageId)
        }
        return null
      }
      if (command === 'vision_delete_history_image') {
        const imageId = stringArgument(args.imageId)
        visionTestState.committedImageIds = visionTestState.committedImageIds.filter((id) => id !== imageId)
        return null
      }
      if (command === 'vision_start_safe_drag') {
        visionTestState.safeDragCalls += 1
        if (visionTestState.safeDragRejectsRemaining > 0) {
          visionTestState.safeDragRejectsRemaining -= 1
          throw new Error('Synthetic safe drag failure')
        }
        return null
      }
      if (command.startsWith('vision_')) return null
      throw new Error(`Unhandled Tauri mock command: ${command}`)
    }
    Object.assign(window, {
      __SCREENPILOT_TEST__: visionTestState,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: new URLSearchParams(window.location.search).get('window') ?? 'vision' },
          currentWebview: { label: new URLSearchParams(window.location.search).get('window') ?? 'vision' },
        },
        plugins: { path: { sep: '\\', delimiter: ';' } },
        convertFileSrc: (path: string) => path,
        invoke,
        transformCallback: (callback: (payload: unknown) => void, once = false) => {
          const id = ++callbackSequence
          callbacks.set(id, (payload) => {
            callback(payload)
            if (once) callbacks.delete(id)
          })
          return id
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
      },
    })
  }, {
    image: sampleImage,
    sourceText: ocrSource,
    keepFullscreen: keepFullscreenAfterCapture,
    translatedResult: translatedText,
    streamDelayMs: visionStreamDelayMs,
    deferSetResponses: deferFloatingSetResponses,
    nativeWidthDelta: nativeResizeClientWidthDelta,
    archiveWarningText: archiveWarning,
    directTranslateEnabled: directTranslate,
    initialListenerFailures: listenerFailures,
    initialMethod: initialTranslationMethod,
  })
}
