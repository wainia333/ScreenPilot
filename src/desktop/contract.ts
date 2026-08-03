import type { AppSettings, ProviderSettings, SettingsExport } from '../features/settings/types'

export type WindowRoute = 'settings' | 'translator' | 'prompt-optimizer' | 'vision'

export type TranslationRequest = {
  text: string
  method: string
  sourceLanguage: string
  targetLanguage: string
  generation: number
}

export type TranslationResult = {
  generation: number
  text: string
}

export type PromptOptimizationRequest = {
  text: string
  generation: number
}

export type PromptOptimizationResult = {
  generation: number
  text: string
}

export type SettingsSaveResult = {
  settings: AppSettings
  appliedShortcuts: Record<string, string>
}

export type ProviderKeyChanges = Record<string, string[]>

export type TranslationSettingsPatch = Partial<
  Pick<AppSettings['translation'], 'method' | 'sourceLanguage' | 'targetLanguage'>
>

export type ProviderConnectionResult = {
  success: boolean
  error: string | null
}

export type PermissionStatus = {
  platform: 'windows'
  screenCapture: boolean
  accessibility: boolean
  administrator: boolean
}

export type Unlisten = () => void

export type DesktopPort = {
  loadSettings(): Promise<AppSettings>
  takeStartupNotice(): Promise<string | null>
  saveSettings(settings: AppSettings): Promise<SettingsSaveResult>
  updateTranslationSettings(patch: TranslationSettingsPatch): Promise<void>
  exportSettings(includeSecrets: boolean): Promise<boolean>
  importSettings(): Promise<SettingsExport | null>
  pickDirectory(): Promise<string | null>
  saveProviderKeyChanges(changes: ProviderKeyChanges): Promise<void>
  setProviderKeys(providerId: string, keys: string[]): Promise<void>
  providerKeyCount(providerId: string): Promise<number>
  deleteProviderKeys(providerId: string): Promise<void>
  fetchProviderModels(provider: ProviderSettings): Promise<string[]>
  testProvider(provider: ProviderSettings, keys: string[]): Promise<ProviderConnectionResult>
  translate(request: TranslationRequest): Promise<TranslationResult>
  optimizePrompt(request: PromptOptimizationRequest): Promise<PromptOptimizationResult>
  commitText(text: string, autoPaste: boolean): Promise<void>
  takeTranslatorSelection(): Promise<string>
  hideWindow(): Promise<void>
  resizeWindow(width: number, height: number): Promise<void>
  startDragging(): Promise<void>
  openExternal(url: string): Promise<void>
  permissionStatus(): Promise<PermissionStatus>
  onRoute(listener: (route: WindowRoute) => void): Promise<Unlisten>
  onWindowReset(listener: (route: WindowRoute) => void): Promise<Unlisten>
  onTranslatorPrepare(listener: () => void): Promise<Unlisten>
  onTranslatorSelection(listener: (selection: string) => void): Promise<Unlisten>
}
