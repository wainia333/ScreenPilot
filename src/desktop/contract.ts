import type { AppSettings, ProviderSettings, SettingsExport, SettingsSecrets } from '../features/settings/types'

export type WindowRoute = 'settings' | 'translator' | 'prompt-optimizer' | 'vision'

export type MainNavigationRequest = {
  requestId: number
  route: Extract<WindowRoute, 'settings' | 'prompt-optimizer'>
}

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
  /** The in-process revision after the write. Older adapters may omit it. */
  revision?: number
}

export type SettingsSnapshot = {
  settings: AppSettings
  revision: number
}

/** A recursively partial AppSettings object containing only user edits. */
export type SettingsPatch = Record<string, unknown>

export type SettingsChangedEvent = SettingsSnapshot

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
  karakeepConfigured(): Promise<boolean>
  testKarakeep(baseUrl: string, apiKey?: string): Promise<{ connected: boolean; effectiveMode: string; message: string }>
  loadSettings(): Promise<AppSettings>
  loadSettingsSnapshot(): Promise<SettingsSnapshot>
  takeStartupNotice(): Promise<string | null>
  acknowledgeStartupNotice(): Promise<boolean>
  saveSettings(settings: AppSettings): Promise<SettingsSaveResult>
  saveSettingsPatch(baseRevision: number, patch: SettingsPatch): Promise<SettingsSaveResult>
  updateTranslationSettings(patch: TranslationSettingsPatch): Promise<void>
  exportSettings(includeSecrets: boolean): Promise<boolean>
  importSettings(): Promise<SettingsExport | null>
  pickDirectory(): Promise<string | null>
  saveProviderKeyChanges(changes: ProviderKeyChanges): Promise<void>
  saveAdapterKeyChanges(changes: ProviderKeyChanges): Promise<void>
  saveImportedSecrets(secrets: SettingsSecrets, providerDeletionIds: string[]): Promise<void>
  setProviderKeys(providerId: string, keys: string[]): Promise<void>
  providerKeyCount(providerId: string): Promise<number>
  deleteProviderKeys(providerId: string): Promise<void>
  fetchProviderModels(provider: ProviderSettings, keys?: string[]): Promise<string[]>
  testProvider(provider: ProviderSettings, keys?: string[]): Promise<ProviderConnectionResult>
  translate(request: TranslationRequest): Promise<TranslationResult>
  cancelTranslation(generation: number): Promise<boolean>
  optimizePrompt(request: PromptOptimizationRequest): Promise<PromptOptimizationResult>
  cancelPromptOptimization(generation: number): Promise<boolean>
  commitText(text: string, autoPaste: boolean): Promise<void>
  takeTranslatorSelection(): Promise<string>
  hideWindow(): Promise<void>
  resizeWindow(width: number, height: number): Promise<void>
  startDragging(): Promise<void>
  openExternal(url: string): Promise<void>
  permissionStatus(): Promise<PermissionStatus>
  currentWindowRoute(): Promise<WindowRoute | null>
  onRoute(listener: (route: WindowRoute) => void): Promise<Unlisten>
  onWindowReset(listener: (route: WindowRoute) => void): Promise<Unlisten>
  onMainNavigationRequest(listener: (request: MainNavigationRequest) => void): Promise<Unlisten>
  pendingMainNavigation(): Promise<MainNavigationRequest | null>
  acknowledgeMainNavigation(requestId: number, accepted: boolean): Promise<void>
  onSettingsChanged(listener: (event: SettingsChangedEvent) => void): Promise<Unlisten>
  onTranslatorPrepare(listener: () => void): Promise<Unlisten>
  onTranslatorSelection(listener: (selection: string) => void): Promise<Unlisten>
}
