import { expect, it } from 'vitest'
import { scanTextParts } from './scan-links'
it('links web addresses embedded in text while preserving punctuation and all original text', () => {
  const text = '说明：https://例子.com/路径?q=1，另见 (https://example.org/a(b))。\nwww.example.net/help.'
  const parts = scanTextParts(text)
  expect(parts.map(p => p.text).join('')).toBe(text)
  expect(parts.flatMap(p => p.href ?? [])).toEqual(['https://例子.com/路径?q=1', 'https://example.org/a(b)', 'https://www.example.net/help'])
})
it('keeps non-web payloads and markup as inert selectable text', () => {
  for (const text of ['plain text', 'javascript:alert(1)', 'file:///C:/Windows', '<img src=x onerror=alert(1)>', 'http://']) {
    expect(scanTextParts(text)).toEqual([{ text }])
  }
})
