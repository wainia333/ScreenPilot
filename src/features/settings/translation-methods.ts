import type { TranslationMethod } from './types'

export const translationMethodOptions: { value: TranslationMethod; label: string }[] = [
  { value: 'ai', label: 'AI' },
  { value: 'baidu', label: '百度' },
  { value: 'google', label: 'Google' },
  { value: 'tencent', label: '腾讯' },
  { value: 'bing', label: 'Bing' },
  { value: 'bing2', label: 'Bing 2' },
  { value: 'yandex', label: 'Yandex' },
  { value: 'caiyun2', label: '彩云小译 2' },
  { value: 'microsoft', label: 'Microsoft' },
]
