export const ADAPTER_CREDENTIALS = [
  { id: 'adapter-baidu-ocr', label: '百度 OCR', labelEn: 'Baidu OCR', fields: ['API Key', 'Secret Key'] },
  { id: 'adapter-baidu-translation', label: '百度翻译', labelEn: 'Baidu Translate', fields: ['App ID', 'Secret'] },
  { id: 'adapter-tencent-translation', label: '腾讯翻译', labelEn: 'Tencent Translate', fields: ['Secret ID', 'Secret Key'] },
  { id: 'adapter-caiyun-translation', label: '彩云小译 2', labelEn: 'Caiyun 2', fields: ['Token'] },
] as const

export type AdapterCredentialId = typeof ADAPTER_CREDENTIALS[number]['id']
export type AdapterCredentialDrafts = Partial<Record<AdapterCredentialId, string>>
export type AdapterCredentialCounts = Partial<Record<AdapterCredentialId, number>>
