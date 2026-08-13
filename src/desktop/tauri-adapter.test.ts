import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderSettings } from '../features/settings/types'
import { DEFAULT_SETTINGS } from '../features/settings/defaults'
import { TauriDesktopPort } from './tauri-adapter'
import type { TauriApi, TauriEvent } from './tauri-api'

type Invocation = { command: string; args?: Record<string, unknown> }

class RecordingTauriApi implements TauriApi {
  readonly invocations: Invocation[] = []
  readonly listeners = new Map<string, (event: TauriEvent<unknown>) => void>()
  readonly windowCalls: { name: 'resize' | 'drag'; width?: number; height?: number }[] = []

  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.invocations.push(args === undefined ? { command } : { command, args })
    if (command === 'settings_load') return Promise.resolve(structuredClone(DEFAULT_SETTINGS) as T)
    if (command === 'startup_notice_take') return Promise.resolve(null as T)
    if (command === 'startup_notice_acknowledge') return Promise.resolve(true as T)
    if (command === 'settings_save') {
      return Promise.resolve({ settings: args?.settings, appliedShortcuts: {} } as T)
    }
    if (command === 'settings_import') return Promise.resolve(null as T)
    if (command === 'settings_export' || command === 'translator_cancel' || command === 'optimizer_cancel') {
      return Promise.resolve(true as T)
    }
    if (command === 'directory_pick') return Promise.resolve('C:\\Archive' as T)
    if (command === 'credentials_provider_key_count') return Promise.resolve(2 as T)
    if (command === 'providers_fetch_models') return Promise.resolve(['model-a'] as T)
    if (command === 'providers_test') return Promise.resolve({ success: true, error: null } as T)
    if (command === 'translator_translate') {
      const request = args?.request as { generation: number }
      return Promise.resolve({ generation: request.generation, text: 'translated' } as T)
    }
    if (command === 'optimizer_run') {
      const request = args?.request as { generation: number }
      return Promise.resolve({ generation: request.generation, text: 'optimized' } as T)
    }
    if (command === 'translator_take_selection') return Promise.resolve('selection' as T)
    if (command === 'permissions_status') {
      return Promise.resolve({ platform: 'windows', screenCapture: true, accessibility: true, administrator: false } as T)
    }
    return Promise.resolve(null as T)
  }

  listen<T>(event: string, handler: (event: TauriEvent<T>) => void): Promise<() => void> {
    this.listeners.set(event, handler as (event: TauriEvent<unknown>) => void)
    return Promise.resolve(() => this.listeners.delete(event))
  }

  resizeCurrentWindow(width: number, height: number): Promise<void> {
    this.windowCalls.push({ name: 'resize', width, height })
    return Promise.resolve()
  }

  startDraggingCurrentWindow(): Promise<void> {
    this.windowCalls.push({ name: 'drag' })
    return Promise.resolve()
  }

  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.({ payload })
  }
}

const provider: ProviderSettings = {
  id: 'provider-a',
  name: 'Provider A',
  baseUrl: 'https://example.com/v1',
  keyCount: 1,
  availableModels: [],
  enabledModels: [],
}

describe('TauriDesktopPort command contract', () => {
  it('maps the settings, credential and provider operations to typed Tauri commands', async () => {
    const api = new RecordingTauriApi()
    const port = new TauriDesktopPort(api)
    const settings: AppSettings = structuredClone(DEFAULT_SETTINGS)

    await expect(port.loadSettings()).resolves.toEqual(settings)
    await expect(port.takeStartupNotice()).resolves.toBeNull()
    await expect(port.acknowledgeStartupNotice()).resolves.toBe(true)
    await expect(port.saveSettings(settings)).resolves.toMatchObject({ settings })
    await port.updateTranslationSettings({ method: 'google', sourceLanguage: 'en' })
    await port.exportSettings(true)
    await port.importSettings()
    await port.pickDirectory()
    await port.saveProviderKeyChanges({ 'provider-a': ['secret'] })
    await port.saveImportedSecrets({ schemaVersion: 1, providers: {}, adapters: {} }, ['old-provider'])
    await port.setProviderKeys('provider-a', ['secret'])
    await port.providerKeyCount('provider-a')
    await port.deleteProviderKeys('provider-a')
    await port.fetchProviderModels(provider, ['  draft ', 'ignored-backup'])
    await port.testProvider(provider)

    expect(api.invocations).toEqual([
      { command: 'settings_load' },
      { command: 'startup_notice_take' },
      { command: 'startup_notice_acknowledge' },
      { command: 'settings_save', args: { settings } },
      { command: 'translation_settings_update', args: { patch: { method: 'google', sourceLanguage: 'en' } } },
      { command: 'settings_export', args: { includeSecrets: true } },
      { command: 'settings_import' },
      { command: 'directory_pick' },
      { command: 'credentials_set_provider_keys_batch', args: { changes: { 'provider-a': ['secret'] } } },
      {
        command: 'credentials_set_imported_secrets',
        args: {
          secrets: { schemaVersion: 1, providers: {}, adapters: {} },
          providerDeletionIds: ['old-provider'],
        },
      },
      { command: 'credentials_set_provider_keys', args: { providerId: 'provider-a', keys: ['secret'] } },
      { command: 'credentials_provider_key_count', args: { providerId: 'provider-a' } },
      { command: 'credentials_delete_provider_keys', args: { providerId: 'provider-a' } },
      { command: 'providers_fetch_models', args: { provider, keys: ['draft'] } },
      { command: 'providers_test', args: { provider } },
    ])
  })

  it('maps text, window and permission operations without changing payload names', async () => {
    const api = new RecordingTauriApi()
    const port = new TauriDesktopPort(api)
    const translation = { text: 'hello', method: 'google', sourceLanguage: 'en', targetLanguage: 'zh-CN', generation: 7 }
    const optimization = { text: 'draft', generation: 8 }

    await expect(port.translate(translation)).resolves.toEqual({ generation: 7, text: 'translated' })
    await expect(port.cancelTranslation(7)).resolves.toBe(true)
    await expect(port.optimizePrompt(optimization)).resolves.toEqual({ generation: 8, text: 'optimized' })
    await expect(port.cancelPromptOptimization(8)).resolves.toBe(true)
    await port.commitText('result', true)
    await expect(port.takeTranslatorSelection()).resolves.toBe('selection')
    await port.hideWindow()
    await port.resizeWindow(640, 480)
    await port.startDragging()
    await port.openExternal('https://example.com')
    await expect(port.permissionStatus()).resolves.toMatchObject({ platform: 'windows' })

    expect(api.invocations).toEqual([
      { command: 'translator_translate', args: { request: translation } },
      { command: 'translator_cancel', args: { generation: 7 } },
      { command: 'optimizer_run', args: { request: optimization } },
      { command: 'optimizer_cancel', args: { generation: 8 } },
      { command: 'text_commit', args: { text: 'result', autoPaste: true } },
      { command: 'translator_take_selection' },
      { command: 'window_hide' },
      { command: 'open_external', args: { url: 'https://example.com' } },
      { command: 'permissions_status' },
    ])
    expect(api.windowCalls).toEqual([
      { name: 'resize', width: 640, height: 480 },
      { name: 'drag' },
    ])
  })

  it('forwards every supported event payload and returns the native unlisten function', async () => {
    const api = new RecordingTauriApi()
    const port = new TauriDesktopPort(api)
    const observed: unknown[] = []
    const unlisten = await Promise.all([
      port.onRoute((payload) => observed.push(payload)),
      port.onWindowReset((payload) => observed.push(payload)),
      port.onTranslatorPrepare(() => observed.push('prepare')),
      port.onTranslatorSelection((payload) => observed.push(payload)),
    ])

    api.emit('screenpilot:route', 'translator')
    api.emit('screenpilot:reset', 'settings')
    api.emit('screenpilot:translator-prepare', undefined)
    api.emit('screenpilot:translator-selection', 'selected text')
    expect(observed).toEqual(['translator', 'settings', 'prepare', 'selected text'])

    unlisten.forEach((dispose) => dispose())
    expect(api.listeners.size).toBe(0)
  })
})
