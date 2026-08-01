import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import type { AppSettings, ProviderSettings, SettingsExport } from '../features/settings/types'
import type {
  DesktopPort,
  PermissionStatus,
  PromptOptimizationRequest,
  PromptOptimizationResult,
  SettingsSaveResult,
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
  name: K,
  handler: (value: EventPayloads[K]) => void,
): Promise<Unlisten> {
  const unlisten = await listen<EventPayloads[K]>(name, ({ payload }) => handler(payload))
  return unlisten
}

function command(name: string, args?: Record<string, unknown>): Promise<void> {
  return invoke<null>(name, args).then(() => undefined)
}

export class TauriDesktopPort implements DesktopPort {
  loadSettings = () => invoke<AppSettings>('settings_load')
  takeStartupNotice = () => invoke<string | null>('startup_notice_take')
  saveSettings = (settings: AppSettings) => invoke<SettingsSaveResult>('settings_save', { settings })
  exportSettings = (includeSecrets: boolean) => invoke<boolean>('settings_export', { includeSecrets })
  importSettings = () => invoke<SettingsExport | null>('settings_import')
  pickDirectory = () => invoke<string | null>('directory_pick')
  setProviderKeys = (providerId: string, keys: string[]) =>
    command('credentials_set_provider_keys', { providerId, keys })
  providerKeyCount = (providerId: string) => invoke<number>('credentials_provider_key_count', { providerId })
  deleteProviderKeys = (providerId: string) => command('credentials_delete_provider_keys', { providerId })
  fetchProviderModels = (provider: ProviderSettings) => invoke<string[]>('providers_fetch_models', { provider })
  testProvider = (provider: ProviderSettings, keys: string[]) =>
    invoke<{ success: boolean; error: string | null }>('providers_test', { provider, keys })
  translate = (request: TranslationRequest) => invoke<TranslationResult>('translator_translate', { request })
  optimizePrompt = (request: PromptOptimizationRequest) =>
    invoke<PromptOptimizationResult>('optimizer_run', { request })
  commitText = (text: string, autoPaste: boolean) => command('text_commit', { text, autoPaste })
  takeTranslatorSelection = () => invoke<string>('translator_take_selection')
  hideWindow = () => command('window_hide')
  resizeWindow = (width: number, height: number) => getCurrentWindow().setSize(new LogicalSize(width, height))
  startDragging = () => getCurrentWindow().startDragging()
  openExternal = (url: string) => command('open_external', { url })
  permissionStatus = () => invoke<PermissionStatus>('permissions_status')
  onRoute = (listener: (route: WindowRoute) => void) => event('screenpilot:route', listener)
  onWindowReset = (listener: (route: WindowRoute) => void) => event('screenpilot:reset', listener)
  onTranslatorPrepare = (listener: () => void) => event('screenpilot:translator-prepare', listener)
  onTranslatorSelection = (listener: (selection: string) => void) => event('screenpilot:translator-selection', listener)
}
