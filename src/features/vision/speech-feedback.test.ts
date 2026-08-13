import { describe, expect, it } from 'vitest'
import { resolveVisionSpeechFailure, visionSpeechControlLabel } from './speech-feedback'

const labels = { speak: '朗读', stop: '停止', retry: '重试朗读' }

describe('Vision speech feedback', () => {
  it('reports a localized failure only for the current playback sequence', () => {
    expect(resolveVisionSpeechFailure(7, 7, 'translated', '朗读失败，请重试')).toEqual({
      target: 'translated',
      announcement: '朗读失败，请重试',
    })
    expect(resolveVisionSpeechFailure(7, 8, 'translated', '朗读失败，请重试')).toBeNull()
  })

  it('offers retry after failure while preserving stop and normal labels', () => {
    expect(visionSpeechControlLabel('original', null, null, labels)).toBe('朗读')
    expect(visionSpeechControlLabel('original', 'original', 'original', labels)).toBe('停止')
    expect(visionSpeechControlLabel('original', null, 'original', labels)).toBe('重试朗读')
    expect(visionSpeechControlLabel('translated', null, 'original', labels)).toBe('朗读')
  })
})
