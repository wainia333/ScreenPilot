import type { AppSettings, ProviderSettings, SettingsExport, SettingsSecrets } from '../features/settings/types'
import { providerCommandArgs } from './provider-command-args'
import { defaultTauriApi, type TauriApi } from './tauri-api'
import type {
  DesktopPort,
  PermissionStatus,
  ProviderKeyChanges,
  PromptOptimizationRequest,
  PromptOptimizationResult,
  SettingsSaveResult,
  TranslationSettingsPatch,
  TranslationRequest,
  TranslationResult,
  Unlisten,
  WindowRoute,
} from './contract'

type EventPayloads = {
  'screenpilot:route': WindowRoute
  'screenpilot:reset': WindowRoute
  'screenpilot:translator-prepare': undefined
  'screenpilot:translator-selection': string
}

async function event<K extends keyof EventPayloads>(
  api: TauriApi,
  name: K,
  handler: (value: EventPayloads[K]) => void,
): Promise<Unlisten> {
  const unlisten = await api.listen<EventPayloads[K]>(name, ({ payload }) => handler(payload))
  return unlisten
}

function command(api: TauriApi, name: string, args?: Record<string, unknown>): Promise<void> {
  return api.invoke<null>(name, args).then(() => undefined)
}

export class TauriDesktopPort implements DesktopPort {
  constructor(private readonly api: TauriApi = defaultTauriApi) {}

  loadSettings = () => this.api.invoke<AppSettings>('settings_load')
  takeStartupNotice = () => this.api.invoke<string | null>('startup_notice_take')
  acknowledgeStartupNotice = () => this.api.invoke<boolean>('startup_notice_acknowledge')
  saveSettings = (settings: AppSettings) => this.api.invoke<SettingsSaveResult>('settings_save', { settings })
  updateTranslationSettings = (patch: TranslationSettingsPatch) =>
    command(this.api, 'translation_settings_update', { patch })
  exportSettings = (includeSecrets: boolean) => this.api.invoke<boolean>('settings_export', { includeSecrets })
  importSettings = () => this.api.invoke<SettingsExport | null>('settings_import')
  pickDirectory = () => this.api.invoke<string | null>('directory_pick')
  saveProviderKeyChanges = (changes: ProviderKeyChanges) =>
    command(this.api, 'credentials_set_provider_keys_batch', { changes })
  saveImportedSecrets = (secrets: SettingsSecrets, providerDeletionIds: string[]) =>
    command(this.api, 'credentials_set_imported_secrets', { secrets, providerDeletionIds })
  setProviderKeys = (providerId: string, keys: string[]) =>
    command(this.api, 'credentials_set_provider_keys', { providerId, keys })
  providerKeyCount = (providerId: string) => this.api.invoke<number>('credentials_provider_key_count', { providerId })
  deleteProviderKeys = (providerId: string) => command(this.api, 'credentials_delete_provider_keys', { providerId })
  fetchProviderModels = (provider: ProviderSettings, keys?: string[]) =>
    this.api.invoke<string[]>('providers_fetch_models', providerCommandArgs(provider, keys))
  testProvider = (provider: ProviderSettings, keys?: string[]) =>
    this.api.invoke<{ success: boolean; error: string | null }>('providers_test', providerCommandArgs(provider, keys))
  translate = (request: TranslationRequest) => this.api.invoke<TranslationResult>('translator_translate', { request })
  cancelTranslation = (generation: number) => this.api.invoke<boolean>('translator_cancel', { generation })
  optimizePrompt = (request: PromptOptimizationRequest) =>
    this.api.invoke<PromptOptimizationResult>('optimizer_run', { request })
  cancelPromptOptimization = (generation: number) =>
    this.api.invoke<boolean>('optimizer_cancel', { generation })
  commitText = (text: string, autoPaste: boolean) => command(this.api, 'text_commit', { text, autoPaste })
  takeTranslatorSelection = () => this.api.invoke<string>('translator_take_selection')
  hideWindow = () => command(this.api, 'window_hide')
  resizeWindow = (width: number, height: number) => this.api.resizeCurrentWindow(width, height)
  startDragging = () => this.api.startDraggingCurrentWindow()
  openExternal = (url: string) => command(this.api, 'open_external', { url })
  permissionStatus = () => this.api.invoke<PermissionStatus>('permissions_status')
  onRoute = (listener: (route: WindowRoute) => void) => event(this.api, 'screenpilot:route', listener)
  onWindowReset = (listener: (route: WindowRoute) => void) => event(this.api, 'screenpilot:reset', listener)
  onTranslatorPrepare = (listener: () => void) => event(this.api, 'screenpilot:translator-prepare', listener)
  onTranslatorSelection = (listener: (selection: string) => void) => event(this.api, 'screenpilot:translator-selection', listener)
}
