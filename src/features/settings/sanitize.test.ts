import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './defaults'
import { sanitizeSettings, validateSettings } from './sanitize'

describe('sanitizeSettings', () => {
  it('returns safe defaults for corrupted input', () => {
    expect(sanitizeSettings('{broken')).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps retry attempts', () => {
    expect(sanitizeSettings({ retry: { attempts: 99 } }).retry.attempts).toBe(5)
    expect(sanitizeSettings({ retry: { attempts: -2 } }).retry.attempts).toBe(1)
  })

  it('restores an unsupported screenshot target language to automatic', () => {
    const settings = sanitizeSettings({ screenshotTranslation: { targetLanguage: 'unsupported' } })
    expect(settings.screenshotTranslation.targetLanguage).toBe('auto')
  })

  it('restores an unsupported text target language to automatic', () => {
    const settings = sanitizeSettings({ translation: { targetLanguage: 'unsupported' } })
    expect(settings.translation.targetLanguage).toBe('auto')
  })

  it('keeps structured model names containing colons', () => {
    const settings = sanitizeSettings({
      providers: [
        {
          id: 'provider-a',
          name: 'Provider A',
          baseUrl: 'https://api.example.com/v1/responses',
          availableModels: ['vendor:model:latest'],
          enabledModels: ['vendor:model:latest'],
        },
      ],
      vision: { model: { providerId: 'provider-a', model: 'vendor:model:latest' } },
    })
    expect(settings.vision.model).toEqual({ providerId: 'provider-a', model: 'vendor:model:latest' })
  })

  it('drops model selections pointing to missing providers', () => {
    const settings = sanitizeSettings({ vision: { model: { providerId: 'missing', model: 'x' } } })
    expect(settings.vision.model).toBeNull()
  })

  it('migrates missing AI switches only when the selected model is enabled', () => {
    const settings = sanitizeSettings({
      providers: [{
        id: 'provider-a',
        name: 'Provider A',
        baseUrl: 'https://api.example.com/v1',
        availableModels: ['model-a'],
        enabledModels: ['model-a'],
      }],
      translation: { method: 'ai', aiModel: { providerId: 'provider-a', model: 'model-a' } },
      screenshotTranslation: {
        ocrMethod: 'ai',
        ocrModel: { providerId: 'provider-a', model: 'model-a' },
        translationMethod: 'ai',
        translationModel: { providerId: 'provider-a', model: 'missing' },
      },
    })
    expect(settings.translation.aiEnabled).toBe(true)
    expect(settings.translation.method).toBe('ai')
    expect(settings.screenshotTranslation.ocrAiEnabled).toBe(true)
    expect(settings.screenshotTranslation.ocrMethod).toBe('ai')
    expect(settings.screenshotTranslation.translationAiEnabled).toBe(false)
    expect(settings.screenshotTranslation.translationModel).toBeNull()
    expect(settings.screenshotTranslation.translationMethod).toBe('microsoft')
  })

  it('falls back from AI methods when a switch is turned off or a model is disabled', () => {
    const settings = sanitizeSettings({
      providers: [{
        id: 'provider-a',
        name: 'Provider A',
        baseUrl: 'https://api.example.com/v1',
        availableModels: ['model-a'],
        enabledModels: ['model-a'],
      }],
      translation: {
        aiEnabled: false,
        method: 'ai',
        aiModel: { providerId: 'provider-a', model: 'model-a' },
      },
      screenshotTranslation: {
        ocrAiEnabled: false,
        ocrMethod: 'ai',
        ocrModel: { providerId: 'provider-a', model: 'model-a' },
        translationAiEnabled: true,
        translationMethod: 'ai',
        translationModel: { providerId: 'provider-a', model: 'model-a' },
      },
    })
    expect(settings.translation.method).toBe('microsoft')
    expect(settings.screenshotTranslation.ocrMethod).toBe('chaoxing')
    expect(settings.screenshotTranslation.translationMethod).toBe('ai')
    const provider = settings.providers[0]
    expect(provider).toBeDefined()
    if (provider === undefined) throw new Error('provider missing')
    const withoutModel = sanitizeSettings({
      ...settings,
      providers: [{ ...provider, enabledModels: [] }],
    })
    expect(withoutModel.screenshotTranslation.translationMethod).toBe('microsoft')
    expect(withoutModel.screenshotTranslation.translationModel).toBeNull()
  })

  it('deduplicates provider models', () => {
    const settings = sanitizeSettings({
      providers: [
        {
          id: 'provider-a',
          name: 'Provider A',
          baseUrl: 'https://api.example.com/v1',
          availableModels: ['a', 'a', 'b'],
          enabledModels: ['a', 'a', 'missing'],
        },
      ],
    })
    expect(settings.providers[0]?.availableModels).toEqual(['a', 'b'])
    expect(settings.providers[0]?.enabledModels).toEqual(['a'])
  })
})

describe('validateSettings', () => {
  it('rejects duplicate shortcuts', () => {
    const settings = sanitizeSettings({
      shortcuts: {
        translator: 'F2',
        vision: 'f2',
        screenshotTranslation: 'F4',
        promptOptimizer: 'Control+Alt+P',
      },
    })
    expect(validateSettings(settings)).toContainEqual(
      expect.objectContaining({ path: 'shortcuts.vision', code: 'conflict' }),
    )
  })

  it('allows HTTP only for loopback providers', () => {
    const safe = sanitizeSettings({
      providers: [{ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1' }],
    })
    const unsafe = sanitizeSettings({
      providers: [{ id: 'remote', name: 'Remote', baseUrl: 'http://example.com/v1' }],
    })
    expect(validateSettings(safe)).toEqual([])
    expect(validateSettings(unsafe)).toContainEqual(expect.objectContaining({ code: 'unsafe' }))
  })
})
