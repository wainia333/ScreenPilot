import { DEFAULT_SETTINGS } from '../features/settings/defaults'
import { sanitizeSettings } from '../features/settings/sanitize'
import type { AppSettings, ProviderSettings, SettingsExport, SettingsSecrets } from '../features/settings/types'
import type {
  DesktopPort,
  SettingsChangedEvent,
  SettingsPatch,
  PromptOptimizationRequest,
  PromptOptimizationResult,
  SettingsSaveResult,
  SettingsSnapshot,
  ProviderKeyChanges,
  TranslationSettingsPatch,
  TranslationRequest,
  TranslationResult,
  Unlisten,
  WindowRoute,
  MainNavigationRequest,
} from './contract'

type FakeListeners = {
  route: Set<(route: WindowRoute) => void>
  reset: Set<(route: WindowRoute) => void>
  mainNavigationRequest: Set<(request: MainNavigationRequest) => void>
  settingsChanged: Set<(event: SettingsChangedEvent) => void>
  translatorPrepare: Set<() => void>
  translatorSelection: Set<(selection: string) => void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergePatch(current: unknown, patch: unknown): unknown {
  if (!isRecord(current) || !isRecord(patch)) return structuredClone(patch)
  const merged: Record<string, unknown> = structuredClone(current)
  Object.entries(patch).forEach(([key, value]) => {
    merged[key] = key in merged ? mergePatch(merged[key], value) : structuredClone(value)
  })
  return merged
}

function hasPatchConflict(base: unknown, current: unknown, patch: unknown): boolean {
  if (!isRecord(patch)) return !sameValue(base, current) && !sameValue(current, patch)
  if (!isRecord(base) || !isRecord(current)) return !sameValue(base, current)
  return Object.entries(patch).some(([key, value]) => hasPatchConflict(base[key], current[key], value))
}

export class FakeDesktopPort implements DesktopPort {
  private integrationConfigured = false
  readonly karakeepTestCalls: { baseUrl: string; apiKey?: string }[] = []
  karakeepConfigured = () => Promise.resolve(this.integrationConfigured)
  testKarakeep = (baseUrl: string, apiKey?: string) => {
    this.karakeepTestCalls.push({ baseUrl, ...(apiKey ? { apiKey } : {}) })
    return Promise.resolve({ connected: true, effectiveMode: 'unknown', message: '测试连接成功（测试替身）' })
  }
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private revision = 0
  private readonly settingsHistory = new Map<number, AppSettings>([[0, structuredClone(DEFAULT_SETTINGS)]])
  startupNotice: string | null = null
  startupNoticeAcknowledgeCalls = 0
  private readonly keys = new Map<string, string[]>()
  readonly providerKeySaveCalls: ProviderKeyChanges[] = []
  readonly adapterKeySaveCalls: ProviderKeyChanges[] = []
  readonly importedSecretsSaveCalls: {
    secrets: SettingsSecrets
    providerDeletionIds: string[]
  }[] = []
  readonly providerModelFetchCalls: { provider: ProviderSettings; keys?: string[] }[] = []
  readonly providerTestCalls: { provider: ProviderSettings; keys?: string[] }[] = []
  readonly translationCancelCalls: number[] = []
  readonly promptOptimizationCancelCalls: number[] = []
  readonly mainNavigationAcks: { requestId: number; accepted: boolean }[] = []
  private pendingNavigation: MainNavigationRequest | null = null
  private windowRoute: WindowRoute | null = null
  providerKeySaveError: string | null = null
  adapterKeySaveError: string | null = null
  importedSecretsSaveError: string | null = null
  private readonly listeners: FakeListeners = {
    route: new Set(),
    reset: new Set(),
    mainNavigationRequest: new Set(),
    settingsChanged: new Set(),
    translatorPrepare: new Set(),
    translatorSelection: new Set(),
  }

  loadSettings(): Promise<AppSettings> {
    return Promise.resolve(structuredClone(this.settings))
  }

  loadSettingsSnapshot(): Promise<SettingsSnapshot> {
    return this.loadSettings().then((settings) => ({ settings, revision: this.revision }))
  }

  takeStartupNotice(): Promise<string | null> {
    return Promise.resolve(this.startupNotice)
  }

  acknowledgeStartupNotice(): Promise<boolean> {
    this.startupNoticeAcknowledgeCalls += 1
    this.startupNotice = null
    return Promise.resolve(true)
  }

  saveSettings(settings: AppSettings): Promise<SettingsSaveResult> {
    this.settings = sanitizeSettings(settings)
    this.revision += 1
    this.settingsHistory.set(this.revision, structuredClone(this.settings))
    const result = {
      settings: structuredClone(this.settings),
      appliedShortcuts: { ...this.settings.shortcuts },
      revision: this.revision,
    }
    this.emitSettingsChanged()
    return Promise.resolve(result)
  }

  saveSettingsPatch(baseRevision: number, patch: SettingsPatch): Promise<SettingsSaveResult> {
    const baseline = this.settingsHistory.get(baseRevision)
    if (baseline === undefined) return Promise.reject(new Error('SETTINGS_CONFLICT: baseline is no longer available'))
    const currentValue = structuredClone(this.settings) as unknown
    const baselineValue = structuredClone(baseline) as unknown
    if (hasPatchConflict(baselineValue, currentValue, patch)) {
      return Promise.reject(new Error('SETTINGS_CONFLICT: settings changed in another window'))
    }
    const merged = mergePatch(currentValue, patch)
    if (sameValue(merged, currentValue)) {
      return Promise.resolve({
        settings: structuredClone(this.settings),
        appliedShortcuts: { ...this.settings.shortcuts },
        revision: this.revision,
      })
    }
    return this.saveSettings(sanitizeSettings(merged))
  }

  updateTranslationSettings(patch: TranslationSettingsPatch): Promise<void> {
    this.settings = sanitizeSettings({
      ...this.settings,
      translation: { ...this.settings.translation, ...patch },
    })
    this.revision += 1
    this.settingsHistory.set(this.revision, structuredClone(this.settings))
    this.emitSettingsChanged()
    return Promise.resolve()
  }

  exportSettings(includeSecrets: boolean): Promise<boolean> {
    void includeSecrets
    return Promise.resolve(true)
  }

  importSettings(): Promise<SettingsExport | null> {
    return Promise.resolve(null)
  }

  pickDirectory(): Promise<string | null> {
    return Promise.resolve('C:\\Users\\ScreenPilot\\Pictures')
  }

  saveProviderKeyChanges(changes: ProviderKeyChanges): Promise<void> {
    this.providerKeySaveCalls.push(structuredClone(changes))
    if (this.providerKeySaveError !== null) return Promise.reject(new Error(this.providerKeySaveError))
    Object.entries(changes).forEach(([providerId, keys]) => {
      this.keys.set(providerId, keys.filter((key) => key.trim().length > 0))
    })
    return Promise.resolve()
  }

  saveAdapterKeyChanges(changes: ProviderKeyChanges): Promise<void> {
    this.adapterKeySaveCalls.push(structuredClone(changes))
    if (this.adapterKeySaveError !== null) return Promise.reject(new Error(this.adapterKeySaveError))
    Object.entries(changes).forEach(([adapterId, keys]) => {
      this.keys.set(adapterId, keys.filter((key) => key.trim().length > 0))
    })
    return Promise.resolve()
  }

  saveImportedSecrets(secrets: SettingsSecrets, providerDeletionIds: string[]): Promise<void> {
    this.importedSecretsSaveCalls.push({
      secrets: structuredClone(secrets),
      providerDeletionIds: [...providerDeletionIds],
    })
    if (this.importedSecretsSaveError !== null) {
      return Promise.reject(new Error(this.importedSecretsSaveError))
    }
    providerDeletionIds.forEach((providerId) => this.keys.delete(providerId))
    if (secrets.integrations?.karakeep?.length) this.integrationConfigured = true
    Object.entries({ ...secrets.providers, ...secrets.adapters }).forEach(([credentialId, keys]) => {
      this.keys.set(credentialId, keys.filter((key) => key.trim().length > 0))
    })
    return Promise.resolve()
  }

  setProviderKeys(providerId: string, keys: string[]): Promise<void> {
    this.keys.set(providerId, keys.filter((key) => key.trim().length > 0))
    return Promise.resolve()
  }

  providerKeyCount(providerId: string): Promise<number> {
    return Promise.resolve(this.keys.get(providerId)?.length ?? 0)
  }

  deleteProviderKeys(providerId: string): Promise<void> {
    this.keys.delete(providerId)
    return Promise.resolve()
  }

  fetchProviderModels(provider: ProviderSettings, keys?: string[]): Promise<string[]> {
    this.providerModelFetchCalls.push({
      provider: structuredClone(provider),
      ...(keys === undefined ? {} : { keys: [...keys] }),
    })
    return Promise.resolve(
      provider.availableModels.length > 0
        ? [...provider.availableModels]
        : ['gpt-4o', 'gpt-5:vision', 'local:model'],
    )
  }

  testProvider(provider: ProviderSettings, keys?: string[]): Promise<{ success: boolean; error: string | null }> {
    this.providerTestCalls.push({
      provider: structuredClone(provider),
      ...(keys === undefined ? {} : { keys: [...keys] }),
    })
    const primaryKey = keys === undefined
      ? this.keys.get(provider.id)?.find((key) => key.trim().length > 0) ?? ''
      : keys.find((key) => key.trim().length > 0) ?? ''
    return Promise.resolve(
      provider.baseUrl.length > 0 && primaryKey.length > 0
        ? { success: true, error: null }
        : { success: false, error: 'Provider URL and primary key are required' },
    )
  }

  translate(request: TranslationRequest): Promise<TranslationResult> {
    return Promise.resolve({ generation: request.generation, text: `译文：${request.text}` })
  }

  cancelTranslation(generation: number): Promise<boolean> {
    this.translationCancelCalls.push(generation)
    return Promise.resolve(true)
  }

  optimizePrompt(request: PromptOptimizationRequest): Promise<PromptOptimizationResult> {
    return Promise.resolve({
      generation: request.generation,
      text: `明确目标、约束和输出格式：\n\n${request.text}`,
    })
  }

  cancelPromptOptimization(generation: number): Promise<boolean> {
    this.promptOptimizationCancelCalls.push(generation)
    return Promise.resolve(true)
  }

  commitText(text: string, autoPaste: boolean): Promise<void> {
    void text
    void autoPaste
    return Promise.resolve()
  }

  takeTranslatorSelection(): Promise<string> {
    return Promise.resolve('')
  }

  hideWindow(): Promise<void> {
    return Promise.resolve()
  }

  resizeWindow(width: number, height: number): Promise<void> {
    void width
    void height
    return Promise.resolve()
  }

  startDragging(): Promise<void> {
    return Promise.resolve()
  }

  openExternal(url: string): Promise<void> {
    void url
    return Promise.resolve()
  }

  permissionStatus(): Promise<{ platform: 'windows'; screenCapture: boolean; accessibility: boolean; administrator: boolean }> {
    return Promise.resolve({ platform: 'windows', screenCapture: true, accessibility: true, administrator: false })
  }

  currentWindowRoute(): Promise<WindowRoute | null> {
    return Promise.resolve(this.windowRoute)
  }

  onRoute(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.listeners.route.add(listener)
    return Promise.resolve(() => this.listeners.route.delete(listener))
  }

  onWindowReset(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.listeners.reset.add(listener)
    return Promise.resolve(() => this.listeners.reset.delete(listener))
  }

  onMainNavigationRequest(listener: (request: MainNavigationRequest) => void): Promise<Unlisten> {
    this.listeners.mainNavigationRequest.add(listener)
    return Promise.resolve(() => this.listeners.mainNavigationRequest.delete(listener))
  }

  pendingMainNavigation(): Promise<MainNavigationRequest | null> {
    return Promise.resolve(this.pendingNavigation === null ? null : { ...this.pendingNavigation })
  }

  acknowledgeMainNavigation(requestId: number, accepted: boolean): Promise<void> {
    this.mainNavigationAcks.push({ requestId, accepted })
    if (this.pendingNavigation?.requestId === requestId) this.pendingNavigation = null
    return Promise.resolve()
  }

  onSettingsChanged(listener: (event: SettingsChangedEvent) => void): Promise<Unlisten> {
    this.listeners.settingsChanged.add(listener)
    return Promise.resolve(() => this.listeners.settingsChanged.delete(listener))
  }

  onTranslatorSelection(listener: (selection: string) => void): Promise<Unlisten> {
    this.listeners.translatorSelection.add(listener)
    return Promise.resolve(() => this.listeners.translatorSelection.delete(listener))
  }

  onTranslatorPrepare(listener: () => void): Promise<Unlisten> {
    this.listeners.translatorPrepare.add(listener)
    return Promise.resolve(() => this.listeners.translatorPrepare.delete(listener))
  }

  emitRoute(route: WindowRoute): void {
    this.windowRoute = route
    this.listeners.route.forEach((listener) => listener(route))
  }

  emitReset(route: WindowRoute): void {
    this.windowRoute = route
    this.listeners.reset.forEach((listener) => listener(route))
  }

  emitMainNavigationRequest(request: MainNavigationRequest): void {
    this.pendingNavigation = { ...request }
    this.listeners.mainNavigationRequest.forEach((listener) => listener(request))
  }

  emitTranslatorSelection(selection: string): void {
    this.listeners.translatorSelection.forEach((listener) => listener(selection))
  }

  emitTranslatorPrepare(): void {
    this.listeners.translatorPrepare.forEach((listener) => listener())
  }

  private emitSettingsChanged(): void {
    const event: SettingsChangedEvent = {
      settings: structuredClone(this.settings),
      revision: this.revision,
    }
    this.listeners.settingsChanged.forEach((listener) => listener(event))
  }

}

/**
 * The browser fallback is intentionally separate from FakeDesktopPort. Tests
 * inject FakeDesktopPort to exercise success and failure paths, while the
 * runtime fallback must never claim that a native side effect happened.
 */
export class BrowserPreviewDesktopPort extends FakeDesktopPort {
  override testKarakeep = (baseUrl: string, apiKey?: string) => { void baseUrl; void apiKey; return Promise.reject(this.unsupported('连接 Karakeep；浏览器预览无法使用原生集成')) }
  private unsupported(action: string): Error {
    return new Error(`浏览器预览不支持${action}，请使用 npm run dev 启动 Windows 原生版本。`)
  }

  override exportSettings(includeSecrets: boolean): Promise<boolean> {
    void includeSecrets
    return Promise.reject(this.unsupported('导出配置'))
  }

  override importSettings(): Promise<SettingsExport | null> {
    return Promise.reject(this.unsupported('导入配置'))
  }

  override pickDirectory(): Promise<string | null> {
    return Promise.reject(this.unsupported('选择本地目录'))
  }

  override saveProviderKeyChanges(changes: ProviderKeyChanges): Promise<void> {
    void changes
    return Promise.reject(this.unsupported('保存模型凭据'))
  }

  override saveAdapterKeyChanges(changes: ProviderKeyChanges): Promise<void> {
    void changes
    return Promise.reject(this.unsupported('保存适配器凭据'))
  }

  override saveImportedSecrets(secrets: SettingsSecrets, providerDeletionIds: string[]): Promise<void> {
    void secrets
    void providerDeletionIds
    return Promise.reject(this.unsupported('导入凭据'))
  }

  override setProviderKeys(providerId: string, keys: string[]): Promise<void> {
    void providerId
    void keys
    return Promise.reject(this.unsupported('保存模型凭据'))
  }

  override providerKeyCount(providerId: string): Promise<number> {
    void providerId
    return Promise.reject(this.unsupported('读取模型凭据'))
  }

  override deleteProviderKeys(providerId: string): Promise<void> {
    void providerId
    return Promise.reject(this.unsupported('删除模型凭据'))
  }

  override commitText(text: string, autoPaste: boolean): Promise<void> {
    void text
    void autoPaste
    return Promise.reject(this.unsupported('提交文本或自动粘贴'))
  }

  override takeTranslatorSelection(): Promise<string> {
    return Promise.reject(this.unsupported('读取系统选区'))
  }

  override hideWindow(): Promise<void> {
    return Promise.reject(this.unsupported('隐藏窗口'))
  }

  override resizeWindow(width: number, height: number): Promise<void> {
    void width
    void height
    return Promise.reject(this.unsupported('调整原生窗口'))
  }

  override startDragging(): Promise<void> {
    return Promise.reject(this.unsupported('拖动原生窗口'))
  }

  override openExternal(url: string): Promise<void> {
    void url
    return Promise.reject(this.unsupported('打开外部链接'))
  }

  override permissionStatus(): Promise<{
    platform: 'windows'
    screenCapture: boolean
    accessibility: boolean
    administrator: boolean
  }> {
    return Promise.reject(this.unsupported('读取 Windows 权限状态'))
  }
}
