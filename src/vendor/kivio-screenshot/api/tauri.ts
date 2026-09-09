import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'

export type ExplainMessage = { role: 'user' | 'assistant'; content: string; reasoning?: string }

export type VisionStreamPayload = {
  imageId: string
  requestId: string
  kind: 'answer'
  delta: string
  reasoningDelta?: string
  done?: boolean
  reason?: 'done' | 'cancelled' | 'error'
  full?: string
  error?: string
  incompleteReason?: string
}

export type VisionAskResult = {
  success: boolean
  requestId: string
  response?: string
  error?: string
}

export type VisionTranslateStreamPayload = {
  imageId: string
  requestId: string
  generation?: number
  kind?: 'original' | 'translated'
  delta?: string
  done?: boolean
  success?: boolean
  error?: string | null
}

export type VisionWindowInfo = {
  id: number
  owner: string
  title: string
  x: number
  y: number
  width: number
  height: number
}

export type VisionCursorPosition = {
  x: number
  y: number
}

export type ModelProvider = {
  id: string
  name: string
  keyCount: number
  baseUrl: string
  availableModels: string[]
  enabledModels: string[]
}

export type ProviderConnectionInput = {
  id?: string
  baseUrl: string
  apiKeys: string[]
}

export type Settings = {
  hotkey: string
  theme: 'system' | 'light' | 'dark'
  targetLang: string
  source: string
  autoPaste: boolean
  launchAtStartup: boolean
  launchAtStartupAsAdmin: boolean
  translatorProviderId: string
  translatorModel: string
  translatorPrompt?: string
  providers: ModelProvider[]
  retryEnabled: boolean
  retryAttempts: number
  screenshotTranslation: {
    enabled: boolean
    hotkey: string
    providerId: string
    model: string
    ocrMethod?: 'ai' | 'baidu' | 'chaoxing' | 'system'
    translationMethod?: 'ai' | 'baidu' | 'google' | 'tencent' | 'bing' | 'bing2' | 'yandex' | 'caiyun2' | 'microsoft'
    translateProviderId?: string
    translateModel?: string
    baiduOcr?: {
      apiKeyConfigured: boolean
      secretKeyConfigured: boolean
      languageType?: string
      accurate?: boolean
    }
    baiduTranslate?: {
      appIdConfigured: boolean
      appKeyConfigured: boolean
      sourceLang?: string
    }
    tencentTranslate?: {
      secretIdConfigured: boolean
      secretKeyConfigured: boolean
    }
    caiyunTranslate?: {
      tokenConfigured: boolean
    }
    directTranslate?: boolean
    thinkingEnabled?: boolean
    thinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    streamEnabled?: boolean
    keepFullscreenAfterCapture?: boolean
    useSystemOcr?: boolean
    ocrPrompt?: string
    prompt?: string
  }
  vision: {
    enabled: boolean
    hotkey: string
    providerId?: string
    model?: string
    defaultLanguage?: string
    streamEnabled?: boolean
    thinkingEnabled?: boolean
    thinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    webSearchEnabled?: boolean
    systemPrompt?: string
    questionPrompt?: string
    messageOrder?: 'asc' | 'desc'
    keepFullscreenAfterCapture?: boolean
  }
  promptOptimizer: {
    enabled: boolean
    hotkey: string
    providerId?: string
    model?: string
    defaultLanguage?: string
    systemPrompt?: string
    optimizePrompt?: string
  }
  settingsLanguage?: 'zh' | 'en'
  autoCheckUpdate?: boolean
  imageArchiveEnabled?: boolean
  imageArchivePath?: string
}

export type ScreenshotTranslationSettingsPatch = Partial<Settings['screenshotTranslation']>

export type PromptOptimizationResult = {
  generation: number
  text: string
}

export type UpdateInfo = {
  available: boolean
  version?: string
  tag?: string
  htmlUrl?: string
  body?: string
  publishedAt?: string
}

export type DefaultPromptTemplates = {
  translationTemplate: string
  screenshotOcrPrompt?: string
  screenshotTranslationTemplate?: string
  visionPrompts: {
    zh: { system: string; question: string }
    en: { system: string; question: string }
  }
  promptOptimizerPrompts?: {
    zh: { system: string; optimize: string }
    en: { system: string; optimize: string }
  }
}

export type PermissionStatus = {
  platform: 'macos' | 'other'
  accessibility: boolean
  screenRecording: boolean
}

type Unlisten = () => void

async function on<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  const unlisten = await listen<T>(event, (event) => handler(event.payload), { target: getCurrentWindow().label })
  return () => {
    unlisten()
  }
}

export const api = {
  getSettings: () => invoke<Settings>('vision_runtime_settings_load'),
  getDefaultPromptTemplates: () => invoke<DefaultPromptTemplates>('get_default_prompt_templates'),
  updateScreenshotTranslationSettings: (patch: ScreenshotTranslationSettingsPatch) =>
    invoke<Settings>('screenshot_translation_settings_update', { patch }),
  exportSettingsConfig: () => invoke<boolean>('export_settings_config'),
  importSettingsConfig: () => invoke<Settings | null>('import_settings_config'),

  fetchModels: (providerId: string, provider?: ProviderConnectionInput) =>
    invoke<string[]>('fetch_models', { providerId, provider }),
  testProviderConnection: (providerId: string, provider?: ProviderConnectionInput) =>
    invoke<{ success: boolean; error?: string }>('test_provider_connection', { providerId, provider }),

  getPermissionStatus: () => invoke<PermissionStatus>('get_permission_status'),
  openPermissionSettings: (kind: 'accessibility' | 'screen-recording') =>
    invoke<void>('open_permission_settings', { kind }),

  getAppVersion: () => getVersion(),

  translateText: (text: string) => invoke<string>('translate_text', { text }),
  optimizePrompt: (text: string) => invoke<string>('vision_optimize_prompt', { text }),
  commitTranslation: (text: string) => invoke<void>('commit_translation', { text }),
  takeTranslatorSelection: () => invoke<string>('take_translator_selection'),

  openExternal: (url: string) => invoke<void>('open_external', { url }),

  resizeWindow: async (width: number, height: number) => {
    const win = getCurrentWindow()
    await win.setSize(new LogicalSize(width, height))
  },
  hideWindow: async () => {
    const win = getCurrentWindow()
    await win.hide()
  },
  closeWindow: async () => {
    const win = getCurrentWindow()
    await win.hide()
  },
  showWindow: async () => {
    const win = getCurrentWindow()
    await win.show()
  },
  startDragging: async () => {
    const win = getCurrentWindow()
    await win.startDragging()
  },
  setAlwaysOnTop: async (alwaysOnTop: boolean) => {
    const win = getCurrentWindow()
    await win.setAlwaysOnTop(alwaysOnTop)
  },

  onOpenSettings: (listener: () => void) => on('open-settings', () => listener()),

  explainReadImage: (imageId: string) =>
    invoke<{ success: boolean; data?: string; error?: string }>('explain_read_image', { imageId }),

  onVisionCaptureReady: (listener: (payload: { requestId: string }) => void) =>
    on('vision-capture-ready', listener),
  onVisionStream: (listener: (payload: VisionStreamPayload) => void) =>
    on<VisionStreamPayload>('vision-stream', (payload) => listener(payload)),
  onVisionTranslateStream: (listener: (payload: VisionTranslateStreamPayload) => void) =>
    on<VisionTranslateStreamPayload>('vision-translate-stream', (payload) => listener(payload)),
  onVisionClosing: (listener: () => void) =>
    on('screenpilot:vision-closing', () => listener()),
  visionRequest: () => invoke<void>('vision_request'),
  visionCursorPosition: () => invoke<VisionCursorPosition | null>('vision_cursor_position'),
  visionListWindows: () => invoke<VisionWindowInfo[]>('vision_list_windows'),
  visionCaptureWindow: (windowId: number) =>
    invoke<{ success: boolean; imageId?: string; error?: string; archiveWarning?: string }>('vision_capture_window', { windowId }),
  visionCaptureRegion: (params: {
    requestId?: string
    absoluteX: number
    absoluteY: number
    x: number
    y: number
    width: number
    height: number
    scaleFactor: number
  }) => invoke<{ success: boolean; imageId?: string; error?: string; archiveWarning?: string }>('vision_capture_region', params),
  visionRegisterAnnotatedImage: (base64Png: string) =>
    invoke<{ success: boolean; imageId?: string; error?: string }>(
      'vision_register_annotated_image', { base64Png }
    ),
  visionRequestTranslate: () => invoke<void>('vision_request_translate'),
  visionTranslate: (imageId: string, requestId: string) =>
    invoke<{
      success: boolean
      cancelled?: boolean
      requestId?: string
      kind?: 'original' | 'translated'
      original?: string
      translated?: string
      error?: string
    }>(
      'vision_translate', { imageId, requestId }
    ),
  visionTranslateText: (text: string) =>
    invoke<{ success: boolean; cancelled?: boolean; translated?: string; error?: string }>(
      'vision_translate_text', { text }
    ),
  synthesizeSpeech: (text: string) =>
    invoke<{ success: boolean; data?: string; error?: string }>(
      'synthesize_speech', { text }
    ),
  visionAsk: (imageId: string, messages: ExplainMessage[], requestId: string) =>
    invoke<VisionAskResult>('vision_ask', { imageId, messages, requestId }),
  visionCancelStream: () => invoke<void>('vision_cancel_stream'),
  visionClose: () => invoke<void>('vision_close'),
  visionCommitImageToHistory: (imageId: string) =>
    invoke<void>('vision_commit_image_to_history', { imageId }),
  visionDeleteHistoryImage: (imageId: string) =>
    invoke<void>('vision_delete_history_image', { imageId }),
  visionDeleteTemporaryImage: (imageId: string) =>
    invoke<void>('vision_delete_temporary_image', { imageId }),
  visionExportMarkdown: (markdown: string, fileName: string) =>
    invoke<boolean>('vision_export_markdown', { markdown, fileName }),
  visionSetFloating: (rect: {
    x?: number
    y?: number
    width: number
    height: number
    hasScreenshot?: boolean
    hitRegion?: { x: number; y: number; width: number; height: number } | null
  }) =>
    invoke<boolean>('vision_set_floating', { rect }),
  visionFlyFloating: (rect: {
    from: { x: number; y: number }
    to: { x: number; y: number }
    width: number
    height: number
    hasScreenshot?: boolean
    durationMs?: number
  }) =>
    invoke<void>('vision_fly_floating', { rect }),
  visionSetHitRegion: (rect: { x: number; y: number; width: number; height: number } | null) =>
    invoke<boolean>('vision_set_hit_region', { rect }),
  visionSetIgnoreCursorEvents: (ignore: boolean) =>
    invoke<void>('vision_set_ignore_cursor_events', { ignore }),
  takeVisionSelection: () => invoke<string>('take_vision_selection'),

  checkUpdate: () => invoke<UpdateInfo>('check_github_latest_release'),

  appleIntelligenceAvailable: () => invoke<boolean>('apple_intelligence_available'),

  downloadUpdate: (version: string) => invoke<string>('download_update_asset', { version }),

  installUpdate: (path: string) => invoke<void>('install_update_and_quit', { path }),

  onUpdateDownloadProgress: (
    listener: (p: { percent: number; downloadedBytes: number; totalBytes: number }) => void,
  ) => on<{ percent: number; downloadedBytes: number; totalBytes: number }>(
    'update-download-progress',
    (payload) => listener(payload),
  ),

  onUpdateAvailable: (listener: (info: UpdateInfo) => void) =>
    on<UpdateInfo>('update-available', (payload) => listener(payload)),
}
