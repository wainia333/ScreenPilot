import { describe, expect, it } from 'vitest'
import { i18n } from '../vendor/kivio-screenshot/settings/i18n'
import { copyFor } from './ui-copy'

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
})
