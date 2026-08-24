import { describe, expect, it } from 'vitest'
import { resolveVisionTranslateFailureKind } from '../../vendor/kivio-screenshot/Vision'

describe('Vision OCR and translation error routing', () => {
  it('keeps an explicit OCR failure in the source result', () => {
    expect(resolveVisionTranslateFailureKind('original')).toBe('original')
  })

  it('keeps an explicit translation failure in the target result after OCR succeeds', () => {
    expect(resolveVisionTranslateFailureKind('translated')).toBe('translated')
  })

  it('does not infer an untyped invoke failure from rendered content', () => {
    expect(resolveVisionTranslateFailureKind(undefined)).toBe('original')
  })
})
