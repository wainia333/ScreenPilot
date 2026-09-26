import { describe, expect, it } from 'vitest'
import { i18n } from '../vendor/screenshot/settings/i18n'
import { DEFAULT_SETTINGS } from '../features/settings/defaults'
import {
  copyFor,
  modelProviderDestination,
  ocrServiceDestination,
  translationServiceDestination,
} from './ui-copy'

describe('OCR translation naming', () => {
  const keys = [
    'screenshotTranslation',
    'recordScreenshotShortcut',
    'enableScreenshotTranslation',
    'screenshotTargetLanguage',
    'screenshotSourceLanguage',
    'screenshotTranslationModel',
    'screenshotTranslationInterface',
    'screenshotStreamingOutput',
    'screenshotReasoningEffort',
    'screenshotTranslationPrompt',
  ] as const

  it('uses the same Chinese feature name in settings and the capture UI', () => {
    for (const key of keys) expect(copyFor('zh')[key]).toContain('OCR翻译')
    expect(i18n.zh.screenshotTranslate).toBe(copyFor('zh').screenshotTranslation)
    expect(i18n.zh.screenshotTranslationThinkingHint).toContain('OCR翻译')
  })

  it('keeps the English feature labels consistent', () => {
    for (const key of keys) expect(copyFor('en')[key]).toContain('OCR translation')
    expect(i18n.en.screenshotTranslate.toLowerCase())
      .toBe(copyFor('en').screenshotTranslation.toLowerCase())
  })

  it('maps each built-in service to the endpoint used by the native request path', () => {
    expect(ocrServiceDestination(DEFAULT_SETTINGS, 'chaoxing')).toBe('ai.chaoxing.com')
    expect(ocrServiceDestination(DEFAULT_SETTINGS, 'baidu')).toBe('aip.baidubce.com')
    expect(translationServiceDestination(DEFAULT_SETTINGS, 'microsoft', null)).toBe('edge.microsoft.com')
    expect(translationServiceDestination(DEFAULT_SETTINGS, 'google', null))
      .toBe('translate.google.com / translate.googleapis.com')
    expect(translationServiceDestination(DEFAULT_SETTINGS, 'baidu', null)).toBe('fanyi-api.baidu.com')
    expect(translationServiceDestination(DEFAULT_SETTINGS, 'tencent', null)).toBe('tmt.tencentcloudapi.com')
    expect(translationServiceDestination(DEFAULT_SETTINGS, 'yandex', null)).toBe('translate.yandex.net')
    expect(translationServiceDestination(DEFAULT_SETTINGS, 'caiyun2', null)).toBe('api.interpreter.caiyunai.com')
  })

  it('shows the configured model provider without exposing credentials', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.providers = [{
      id: 'gateway',
      name: 'Gateway',
      baseUrl: 'https://gateway.example/v1',
      protocol: 'responses',
      keyCount: 1,
      availableModels: ['vision-model'],
      enabledModels: ['vision-model'],
    }]
    const selection = { providerId: 'gateway', model: 'vision-model' }

    expect(modelProviderDestination(settings, selection)).toBe('Gateway · https://gateway.example/v1')
    expect(translationServiceDestination(settings, 'ai', selection))
      .toBe('Gateway · https://gateway.example/v1')
    expect(modelProviderDestination(settings, { providerId: 'missing', model: 'vision-model' })).toBeNull()
  })
})
