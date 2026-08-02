import { DEFAULT_SETTINGS } from '../features/settings/defaults'
import { sanitizeSettings } from '../features/settings/sanitize'
import type { AppSettings, ProviderSettings, SettingsExport } from '../features/settings/types'
import type {
  DesktopPort,
  PromptOptimizationRequest,
  PromptOptimizationResult,
  SettingsSaveResult,
  TranslationSettingsPatch,
  TranslationRequest,
  TranslationResult,
  Unlisten,
  WindowRoute,
} from './contract'

type FakeListeners = {
  route: Set<(route: WindowRoute) => void>
  reset: Set<(route: WindowRoute) => void>
  translatorPrepare: Set<() => void>
  translatorSelection: Set<(selection: string) => void>
}

export class FakeDesktopPort implements DesktopPort {
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private readonly keys = new Map<string, string[]>()
  private readonly listeners: FakeListeners = {
    route: new Set(),
    reset: new Set(),
    translatorPrepare: new Set(),
    translatorSelection: new Set(),
  }

  loadSettings(): Promise<AppSettings> {
    return Promise.resolve(structuredClone(this.settings))
  }

  takeStartupNotice(): Promise<string | null> {
    return Promise.resolve(null)
  }

  saveSettings(settings: AppSettings): Promise<SettingsSaveResult> {
    this.settings = sanitizeSettings(settings)
    return Promise.resolve({
      settings: structuredClone(this.settings),
      appliedShortcuts: { ...this.settings.shortcuts },
    })
  }

  updateTranslationSettings(patch: TranslationSettingsPatch): Promise<void> {
    this.settings = sanitizeSettings({
      ...this.settings,
      translation: { ...this.settings.translation, ...patch },
    })
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

  fetchProviderModels(provider: ProviderSettings): Promise<string[]> {
    return Promise.resolve(
      provider.availableModels.length > 0
        ? [...provider.availableModels]
        : ['gpt-4o', 'gpt-5:vision', 'local:model'],
    )
  }

  testProvider(provider: ProviderSettings, keys: string[]): Promise<{ success: boolean; error: string | null }> {
    return Promise.resolve(
      provider.baseUrl.length > 0 && keys.some(Boolean)
        ? { success: true, error: null }
        : { success: false, error: 'Provider URL and primary key are required' },
    )
  }

  translate(request: TranslationRequest): Promise<TranslationResult> {
    return Promise.resolve({ generation: request.generation, text: `译文：${request.text}` })
  }

  optimizePrompt(request: PromptOptimizationRequest): Promise<PromptOptimizationResult> {
    return Promise.resolve({
      generation: request.generation,
      text: `明确目标、约束和输出格式：\n\n${request.text}`,
    })
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

  onRoute(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.listeners.route.add(listener)
    return Promise.resolve(() => this.listeners.route.delete(listener))
  }

  onWindowReset(listener: (route: WindowRoute) => void): Promise<Unlisten> {
    this.listeners.reset.add(listener)
    return Promise.resolve(() => this.listeners.reset.delete(listener))
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
    this.listeners.route.forEach((listener) => listener(route))
  }

  emitReset(route: WindowRoute): void {
    this.listeners.reset.forEach((listener) => listener(route))
  }

  emitTranslatorSelection(selection: string): void {
    this.listeners.translatorSelection.forEach((listener) => listener(selection))
  }

  emitTranslatorPrepare(): void {
    this.listeners.translatorPrepare.forEach((listener) => listener())
  }

}
