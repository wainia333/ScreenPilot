export type ThemeMode = 'system' | 'light' | 'dark'

export type InterfaceLanguage = 'zh' | 'en'

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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

export type TranslationLanguage = 'auto' | 'zh-CN' | 'en' | 'ja' | 'ko'

export type ModelSelection = {
  providerId: string
  model: string
}

export type ProviderProtocol = 'chatCompletions' | 'responses'

export type ProviderSettings = {
  id: string
  name: string
  baseUrl: string
  /** Optional while reading pre-protocol settings; sanitization supplies the default. */
  protocol?: ProviderProtocol
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
  sourceLanguage: TranslationLanguage
  targetLanguage: string
  method: TranslationMethod
  aiEnabled: boolean
  aiModel: ModelSelection | null
  prompt: string
}

export type ScreenshotTranslationSettings = {
  enabled: boolean
  sourceLanguage: TranslationLanguage
  targetLanguage: string
  ocrAiEnabled: boolean
  ocrMethod: OcrMethod
  translationMethod: TranslationMethod
  translationAiEnabled: boolean
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
  thinkingEffort: ThinkingEffort
  systemPrompt: string
  optimizePrompt: string
}

export type AppSettings = {
  karakeep: import('../karakeep/types').KarakeepConfig
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
  altSnap: { enabled: boolean; shortcut: string }
  providers: ProviderSettings[]
}

export type SettingsExport = {
  type: 'screenpilot-settings-export'
  schemaVersion: 1
  appVersion: string
  exportedAt: string
  includesSecrets: boolean
  settings: AppSettings
  secrets?: SettingsSecrets
}

export type SettingsSecrets = {
  schemaVersion: 1
  providers: Record<string, string[]>
  adapters: Record<string, string[]>
  integrations?: Record<string, string[]>
}

export type SettingsIssue = {
  path: string
  code: 'invalid' | 'conflict' | 'missing' | 'unsafe'
  message: string
}
