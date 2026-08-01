export type ThemeMode = 'system' | 'light' | 'dark'

export type InterfaceLanguage = 'zh' | 'en'

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type MessageOrder = 'asc' | 'desc'

export type OcrMethod = 'ai' | 'baidu' | 'chaoxing' | 'system'

export type TranslationMethod =
  | 'ai'
  | 'baidu'
  | 'google'
  | 'tencent'
  | 'bing'
  | 'bing2'
  | 'yandex'
  | 'caiyun2'
  | 'microsoft'

export type ModelSelection = {
  providerId: string
  model: string
}

export type ProviderSettings = {
  id: string
  name: string
  baseUrl: string
  keyCount: number
  availableModels: string[]
  enabledModels: string[]
}

export type ShortcutSettings = {
  translator: string
  vision: string
  screenshotTranslation: string
  promptOptimizer: string
}

export type GeneralSettings = {
  autoPaste: boolean
  launchAtStartup: boolean
  launchAtStartupAsAdministrator: boolean
  imageArchiveEnabled: boolean
  imageArchivePath: string
}

export type RetrySettings = {
  enabled: boolean
  attempts: number
}

export type TranslationSettings = {
  targetLanguage: string
  method: TranslationMethod
  aiModel: ModelSelection | null
  prompt: string
}

export type ScreenshotTranslationSettings = {
  enabled: boolean
  targetLanguage: string
  ocrMethod: OcrMethod
  translationMethod: TranslationMethod
  ocrModel: ModelSelection | null
  translationModel: ModelSelection | null
  showSource: boolean
  keepFullscreen: boolean
  stream: boolean
  thinking: boolean
  thinkingEffort: ThinkingEffort
  ocrPrompt: string
  translationPrompt: string
}

export type VisionSettings = {
  enabled: boolean
  responseLanguage: string
  model: ModelSelection | null
  stream: boolean
  thinking: boolean
  thinkingEffort: ThinkingEffort
  webSearch: boolean
  messageOrder: MessageOrder
  keepFullscreen: boolean
  systemPrompt: string
  questionPrompt: string
}

export type PromptOptimizerSettings = {
  enabled: boolean
  responseLanguage: string
  model: ModelSelection | null
  systemPrompt: string
  optimizePrompt: string
}

export type AppSettings = {
  schemaVersion: 1
  theme: ThemeMode
  language: InterfaceLanguage
  retry: RetrySettings
  general: GeneralSettings
  shortcuts: ShortcutSettings
  translation: TranslationSettings
  screenshotTranslation: ScreenshotTranslationSettings
  vision: VisionSettings
  promptOptimizer: PromptOptimizerSettings
  providers: ProviderSettings[]
}

export type SettingsExport = {
  type: 'screenpilot-settings-export'
  schemaVersion: 1
  appVersion: string
  exportedAt: string
  includesSecrets: boolean
  settings: AppSettings
  secrets?: Record<string, string[]>
}

export type SettingsIssue = {
  path: string
  code: 'invalid' | 'conflict' | 'missing' | 'unsafe'
  message: string
}
