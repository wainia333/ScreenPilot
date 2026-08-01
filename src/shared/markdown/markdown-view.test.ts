import { describe, expect, it } from 'vitest'
import { stableMarkdown } from './stable-markdown'

describe('stableMarkdown', () => {
  it('closes incomplete stream fences and block formulas without changing complete input', () => {
    expect(stableMarkdown('```ts\nconst value = 1')).toBe('```ts\nconst value = 1\n```')
    expect(stableMarkdown('$$\nx + y')).toBe('$$\nx + y\n$$')
    expect(stableMarkdown('```text\ndone\n```')).toBe('```text\ndone\n```')
  })
})
