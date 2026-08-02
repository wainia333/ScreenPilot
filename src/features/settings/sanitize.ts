import { DEFAULT_SETTINGS } from './defaults'
import { normalizeShortcut, shortcutIssues } from './shortcuts'
import type {
  AppSettings,
  InterfaceLanguage,
  MessageOrder,
  ModelSelection,
  OcrMethod,
  ProviderSettings,
  SettingsIssue,
  ThemeMode,
  ThinkingEffort,
  TranslationMethod,
} from './types'

type UnknownRecord = Record<string, unknown>

const themes = new Set<ThemeMode>(['system', 'light', 'dark'])
const languages = new Set<InterfaceLanguage>(['zh', 'en'])
const thinkingEfforts = new Set<ThinkingEffort>(['low', 'medium', 'high', 'xhigh'])
const messageOrders = new Set<MessageOrder>(['asc', 'desc'])
const ocrMethods = new Set<OcrMethod>(['ai', 'baidu', 'chaoxing', 'system'])
const screenshotTargetLanguages = new Set(['auto', 'zh-CN', 'en', 'ja', 'ko'])
const translationMethods = new Set<TranslationMethod>([
  'ai',
  'baidu',
  'google',
  'tencent',
  'bing',
  'bing2',
  'yandex',
  'caiyun2',
  'microsoft',
])

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {}
}

function text(value: unknown, fallback: string, limit = 200_000): string {
  return typeof value === 'string' ? value.slice(0, limit) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

function choice<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
}

function modelSelection(value: unknown): ModelSelection | null {
  const data = record(value)
  const providerId = text(data.providerId, '').trim()
  const model = text(data.model, '').trim()
  return providerId.length > 0 && model.length > 0 ? { providerId, model } : null
}

export function isValidModelSelection(
  selection: ModelSelection | null,
  providers: ProviderSettings[],
): selection is ModelSelection {
  if (selection === null) return false
  const provider = providers.find((item) => item.id === selection.providerId)
  return provider?.enabledModels.includes(selection.model) ?? false
}

function legacyAiEnabled(value: unknown, selection: ModelSelection | null, providers: ProviderSettings[]): boolean {
  return typeof value === 'boolean' ? value : isValidModelSelection(selection, providers)
}

function provider(value: unknown, index: number): ProviderSettings | null {
  const data = record(value)
  const id = text(data.id, `provider-${index + 1}`, 80).trim()
  const name = text(data.name, '', 100).trim()
  const baseUrl = text(data.baseUrl, '', 2_048).trim()
  if (id.length === 0 || name.length === 0 || baseUrl.length === 0) return null
  const availableModels = stringList(data.availableModels)
  const enabledModels = stringList(data.enabledModels).filter((model) => availableModels.includes(model))
  return {
    id,
    name,
    baseUrl,
    keyCount: integer(data.keyCount, 0, 0, 64),
    availableModels,
    enabledModels,
  }
}

export function sanitizeSettings(value: unknown): AppSettings {
  const root = record(value)
  const retry = record(root.retry)
  const general = record(root.general)
  const shortcuts = record(root.shortcuts)
  const translation = record(root.translation)
  const screenshot = record(root.screenshotTranslation)
  const vision = record(root.vision)
  const optimizer = record(root.promptOptimizer)
  const providers = Array.isArray(root.providers)
    ? root.providers.map(provider).filter((item): item is ProviderSettings => item !== null)
    : []
  const providerIds = new Set(providers.map((item) => item.id))
  const validModel = (selection: ModelSelection | null) =>
    selection !== null && providerIds.has(selection.providerId) && isValidModelSelection(selection, providers)
      ? selection
      : null
  const translationModel = validModel(modelSelection(translation.aiModel))
  const ocrModel = validModel(modelSelection(screenshot.ocrModel))
  const screenshotTranslationModel = validModel(modelSelection(screenshot.translationModel))
  const sanitized: AppSettings = {
    schemaVersion: 1,
    theme: choice(root.theme, themes, DEFAULT_SETTINGS.theme),
    language: choice(root.language, languages, DEFAULT_SETTINGS.language),
    retry: {
      enabled: flag(retry.enabled, DEFAULT_SETTINGS.retry.enabled),
      attempts: integer(retry.attempts, DEFAULT_SETTINGS.retry.attempts, 1, 5),
    },
    general: {
      autoPaste: flag(general.autoPaste, DEFAULT_SETTINGS.general.autoPaste),
      launchAtStartup: flag(general.launchAtStartup, DEFAULT_SETTINGS.general.launchAtStartup),
      launchAtStartupAsAdministrator: flag(
        general.launchAtStartupAsAdministrator,
        DEFAULT_SETTINGS.general.launchAtStartupAsAdministrator,
      ),
      imageArchiveEnabled: flag(
        general.imageArchiveEnabled,
        DEFAULT_SETTINGS.general.imageArchiveEnabled,
      ),
      imageArchivePath: text(general.imageArchivePath, DEFAULT_SETTINGS.general.imageArchivePath, 1_024),
    },
    shortcuts: {
      translator: normalizeShortcut(text(shortcuts.translator, DEFAULT_SETTINGS.shortcuts.translator)),
      vision: normalizeShortcut(text(shortcuts.vision, DEFAULT_SETTINGS.shortcuts.vision)),
      screenshotTranslation: normalizeShortcut(
        text(shortcuts.screenshotTranslation, DEFAULT_SETTINGS.shortcuts.screenshotTranslation),
      ),
      promptOptimizer: normalizeShortcut(
        text(shortcuts.promptOptimizer, DEFAULT_SETTINGS.shortcuts.promptOptimizer),
      ),
    },
    translation: {
      targetLanguage: choice(
        translation.targetLanguage,
        screenshotTargetLanguages,
        DEFAULT_SETTINGS.translation.targetLanguage,
      ),
      method: choice(translation.method, translationMethods, DEFAULT_SETTINGS.translation.method),
      aiEnabled: legacyAiEnabled(translation.aiEnabled, translationModel, providers),
      aiModel: translationModel,
      prompt: text(translation.prompt, DEFAULT_SETTINGS.translation.prompt),
    },
    screenshotTranslation: {
      enabled: flag(screenshot.enabled, DEFAULT_SETTINGS.screenshotTranslation.enabled),
      targetLanguage: choice(
        screenshot.targetLanguage,
        screenshotTargetLanguages,
        DEFAULT_SETTINGS.screenshotTranslation.targetLanguage,
      ),
      ocrAiEnabled: legacyAiEnabled(screenshot.ocrAiEnabled, ocrModel, providers),
      ocrMethod: choice(screenshot.ocrMethod, ocrMethods, DEFAULT_SETTINGS.screenshotTranslation.ocrMethod),
      translationMethod: choice(
        screenshot.translationMethod,
        translationMethods,
        DEFAULT_SETTINGS.screenshotTranslation.translationMethod,
      ),
      translationAiEnabled: legacyAiEnabled(
        screenshot.translationAiEnabled,
        screenshotTranslationModel,
        providers,
      ),
      ocrModel,
      translationModel: screenshotTranslationModel,
      showSource: flag(screenshot.showSource, DEFAULT_SETTINGS.screenshotTranslation.showSource),
      keepFullscreen: false,
      stream: flag(screenshot.stream, DEFAULT_SETTINGS.screenshotTranslation.stream),
      thinking: flag(screenshot.thinking, DEFAULT_SETTINGS.screenshotTranslation.thinking),
      thinkingEffort: choice(
        screenshot.thinkingEffort,
        thinkingEfforts,
        DEFAULT_SETTINGS.screenshotTranslation.thinkingEffort,
      ),
      ocrPrompt: text(screenshot.ocrPrompt, DEFAULT_SETTINGS.screenshotTranslation.ocrPrompt),
      translationPrompt: text(
        screenshot.translationPrompt,
        DEFAULT_SETTINGS.screenshotTranslation.translationPrompt,
      ),
    },
    vision: {
      enabled: flag(vision.enabled, DEFAULT_SETTINGS.vision.enabled),
      responseLanguage: text(vision.responseLanguage, DEFAULT_SETTINGS.vision.responseLanguage, 50),
      model: validModel(modelSelection(vision.model)),
      stream: flag(vision.stream, DEFAULT_SETTINGS.vision.stream),
      thinking: flag(vision.thinking, DEFAULT_SETTINGS.vision.thinking),
      thinkingEffort: choice(vision.thinkingEffort, thinkingEfforts, DEFAULT_SETTINGS.vision.thinkingEffort),
      webSearch: flag(vision.webSearch, DEFAULT_SETTINGS.vision.webSearch),
      messageOrder: choice(vision.messageOrder, messageOrders, DEFAULT_SETTINGS.vision.messageOrder),
      keepFullscreen: false,
      systemPrompt: text(vision.systemPrompt, DEFAULT_SETTINGS.vision.systemPrompt),
      questionPrompt: text(vision.questionPrompt, DEFAULT_SETTINGS.vision.questionPrompt),
    },
    promptOptimizer: {
      enabled: flag(optimizer.enabled, DEFAULT_SETTINGS.promptOptimizer.enabled),
      responseLanguage: text(
        optimizer.responseLanguage,
        DEFAULT_SETTINGS.promptOptimizer.responseLanguage,
        50,
      ),
      model: validModel(modelSelection(optimizer.model)),
      systemPrompt: text(optimizer.systemPrompt, DEFAULT_SETTINGS.promptOptimizer.systemPrompt),
      optimizePrompt: text(optimizer.optimizePrompt, DEFAULT_SETTINGS.promptOptimizer.optimizePrompt),
    },
    providers,
  }
  return normalizeAiAvailability(sanitized)
}

export function normalizeAiAvailability(settings: AppSettings): AppSettings {
  const translationModel = isValidModelSelection(settings.translation.aiModel, settings.providers)
    ? settings.translation.aiModel
    : null
  const ocrModel = isValidModelSelection(settings.screenshotTranslation.ocrModel, settings.providers)
    ? settings.screenshotTranslation.ocrModel
    : null
  const screenshotTranslationModel = isValidModelSelection(
    settings.screenshotTranslation.translationModel,
    settings.providers,
  )
    ? settings.screenshotTranslation.translationModel
    : null
  const translationMethod = settings.translation.method === 'ai'
    && !(settings.translation.aiEnabled && translationModel)
    ? DEFAULT_SETTINGS.translation.method
    : settings.translation.method
  const ocrMethod = settings.screenshotTranslation.ocrMethod === 'ai'
    && !(settings.screenshotTranslation.ocrAiEnabled && ocrModel)
    ? DEFAULT_SETTINGS.screenshotTranslation.ocrMethod
    : settings.screenshotTranslation.ocrMethod
  const screenshotTranslationMethod = settings.screenshotTranslation.translationMethod === 'ai'
    && !(settings.screenshotTranslation.translationAiEnabled && screenshotTranslationModel)
    ? DEFAULT_SETTINGS.screenshotTranslation.translationMethod
    : settings.screenshotTranslation.translationMethod
  if (
    translationModel === settings.translation.aiModel
    && ocrModel === settings.screenshotTranslation.ocrModel
    && screenshotTranslationModel === settings.screenshotTranslation.translationModel
    && translationMethod === settings.translation.method
    && ocrMethod === settings.screenshotTranslation.ocrMethod
    && screenshotTranslationMethod === settings.screenshotTranslation.translationMethod
  ) return settings
  return {
    ...settings,
    translation: {
      ...settings.translation,
      method: translationMethod,
      aiModel: translationModel,
    },
    screenshotTranslation: {
      ...settings.screenshotTranslation,
      ocrMethod,
      ocrModel,
      translationMethod: screenshotTranslationMethod,
      translationModel: screenshotTranslationModel,
    },
  }
}

export function validateSettings(settings: AppSettings): SettingsIssue[] {
  const issues = shortcutIssues(settings.shortcuts)
  const providerIds = new Set<string>()
  for (const provider of settings.providers) {
    if (providerIds.has(provider.id)) {
      issues.push({ path: `providers.${provider.id}`, code: 'conflict', message: 'Provider id must be unique' })
    }
    providerIds.add(provider.id)
    try {
      const url = new URL(provider.baseUrl)
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
        issues.push({ path: `providers.${provider.id}.baseUrl`, code: 'unsafe', message: 'Provider URL must use HTTPS' })
      }
    } catch {
      issues.push({ path: `providers.${provider.id}.baseUrl`, code: 'invalid', message: 'Provider URL is invalid' })
    }
  }
  return issues
}
