import type { Page } from '@playwright/test'

const sampleImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#f1f3f4"/><rect x="80" y="90" width="800" height="360" rx="24" fill="#ffffff" stroke="#d9dddf"/><text x="130" y="180" font-family="Segoe UI" font-size="44" fill="#171a1d">ScreenPilot Visual Test</text><text x="130" y="250" font-family="Segoe UI" font-size="28" fill="#4e565c">可见内容识别 · English OCR · E = mc²</text><rect x="130" y="310" width="520" height="18" rx="9" fill="#c35e42"/></svg>',
)}`

export async function installVisionTauriMock(
  page: Page,
  ocrSource = 'ScreenPilot Visual Test\n可见内容识别 · English OCR · E = mc²',
  keepFullscreenAfterCapture = true,
  translatedText = 'ScreenPilot 视觉测试\n可见内容识别、英文 OCR 与公式 E = mc²',
): Promise<void> {
  await page.addInitScript(({ image, sourceText, keepFullscreen, translatedResult }) => {
    const callbacks = new Map<number, (payload: unknown) => void>()
    const listeners = new Map<string, Map<number, number>>()
    let callbackSequence = 0
    let listenerSequence = 0
    let imageSequence = 0
    const visionTestState = {
      showCount: 0,
      translationRequests: [] as { text: string; targetLanguage: string }[],
      externalUrls: [] as string[],
      answerText: 'The image contains a synthetic ScreenPilot visual test with Chinese, English, and a formula.',
      floatingRect: null as { width: number; height: number } | null,
      floatingRects: [] as { width: number; height: number }[],
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
      translatorPrompt: '',
      providers: [{
        id: 'test-provider',
        name: 'Synthetic Provider',
        apiKeys: ['test-key'],
        baseUrl: 'https://example.invalid/v1',
        availableModels: ['test-model'],
        enabledModels: ['test-model'],
      }],
      retryEnabled: true,
      retryAttempts: 3,
      screenshotTranslation: {
        enabled: true,
        targetLanguage: 'auto',
        hotkey: 'F4',
        providerId: 'test-provider',
        model: 'test-model',
        ocrMethod: 'chaoxing',
        translationMethod: 'microsoft',
        translateProviderId: 'test-provider',
        translateModel: 'test-model',
        directTranslate: false,
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
        systemPrompt: '',
        optimizePrompt: '',
      },
      settingsLanguage: 'zh',
      autoCheckUpdate: false,
      imageArchiveEnabled: false,
      imageArchivePath: '',
    }
    const emit = (event: string, payload: unknown) => {
      for (const [eventId, callbackId] of listeners.get(event) ?? []) {
        callbacks.get(callbackId)?.({ event, id: eventId, payload })
      }
    }
    const unregisterListener = (event: string, eventId: number) => {
      listeners.get(event)?.delete(eventId)
    }
    const stringArgument = (value: unknown) => typeof value === 'string' ? value : ''
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      await Promise.resolve()
      if (command === 'plugin:event|listen') {
        const event = String(args.event)
        const eventId = ++listenerSequence
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
      if (command === 'plugin:window|show') {
        visionTestState.showCount += 1
        return null
      }
      if (command.startsWith('plugin:window|')) return null
      if (command === 'open_external') {
        visionTestState.externalUrls.push(String(args.url))
        return null
      }
      if (command === 'get_settings') return structuredClone(settings)
      if (command === 'save_settings') {
        Object.assign(settings, args.settings)
        return null
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
        return { success: true, imageId: `capture-${++imageSequence}` }
      }
      if (command === 'explain_read_image') return { success: true, data: image }
      if (command === 'vision_register_annotated_image') {
        return { success: true, imageId: `annotated-${++imageSequence}` }
      }
      if (command === 'vision_ask') {
        const imageId = stringArgument(args.imageId)
        emit('vision-stream', {
          imageId,
          kind: 'answer',
          delta: '',
          reasoningDelta: 'Checking the visible content.',
        })
        emit('vision-stream', {
          imageId,
          kind: 'answer',
          delta: visionTestState.answerText,
        })
        emit('vision-stream', { imageId, kind: 'answer', delta: '', done: true, reason: 'done' })
        return { success: true }
      }
      if (command === 'vision_translate') {
        const imageId = stringArgument(args.imageId)
        emit('vision-translate-stream', {
          imageId,
          kind: 'original',
          delta: sourceText,
        })
        emit('vision-translate-stream', {
          imageId,
          kind: 'translated',
          delta: translatedResult,
        })
        emit('vision-translate-stream', { imageId, done: true, success: true })
        return { success: true }
      }
      if (command === 'vision_translate_text') {
        const requestedTarget = stringArgument(args.targetLanguage)
        const targetLanguage = requestedTarget || settings.screenshotTranslation.targetLanguage
        const text = String(args.text)
        visionTestState.translationRequests.push({ text, targetLanguage })
        return { success: true, translated: `编辑后译文(${targetLanguage})：${text}` }
      }
      if (command === 'optimize_prompt') return `明确目标、约束和输出格式：${String(args.text)}`
      if (command === 'synthesize_speech') return { success: true, data: '' }
      if (command === 'vision_set_hit_region') return true
      if (command === 'vision_set_floating') {
        const rect = args.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined
        const screenshotTranslation = location.hash.includes('mode=translate')
        const positionedTranslation = screenshotTranslation
          && Number.isFinite(Number(rect?.x))
          && Number.isFinite(Number(rect?.y))
        const requestedHeight = Number(rect?.height)
        const floatingRect = {
          width: Number(rect?.width),
          height: screenshotTranslation
            ? Math.min(requestedHeight, positionedTranslation ? 224 : 400)
            : requestedHeight,
        }
        visionTestState.floatingRect = floatingRect
        visionTestState.floatingRects.push(floatingRect)
        return null
      }
      if (command === 'vision_fly_floating') {
        const rect = args.rect as { width?: unknown; height?: unknown } | undefined
        const requestedHeight = Number(rect?.height)
        const floatingRect = {
          width: Number(rect?.width),
          height: location.hash.includes('mode=translate') ? Math.min(requestedHeight, 224) : requestedHeight,
        }
        visionTestState.floatingRect = floatingRect
        visionTestState.floatingRects.push(floatingRect)
        return null
      }
      if (command.startsWith('vision_')) return null
      throw new Error(`Unhandled Tauri mock command: ${command}`)
    }
    Object.assign(window, {
      __SCREENPILOT_TEST__: visionTestState,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'vision' }, currentWebview: { label: 'vision' } },
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
  })
}
