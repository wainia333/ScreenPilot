import { describe, expect, it } from 'vitest'
import { buildVisionMarkdown, buildVisionMessageMarkdown, defaultVisionExportFileName } from './vision-export'

describe('Vision Markdown export', () => {
  it('keeps the screenshot and every question/answer in Markdown order', () => {
    const markdown = buildVisionMarkdown({
      appLabel: 'Editor',
      imageDataUrl: 'data:image/png;base64,abc123',
      messages: [
        { role: 'user', content: '请解释这段代码' },
        { role: 'assistant', reasoning: '先分析结构', content: '这是一个示例。' },
        { role: 'user', content: '再总结一下' },
        { role: 'assistant', content: '总结如下。' },
      ],
    })

    expect(markdown).toContain('# Vision 对话')
    expect(markdown).toContain('> 来源: Editor')
    expect(markdown).toContain('![截图](data:image/png;base64,abc123)')
    expect(markdown.indexOf('## 提问 1')).toBeLessThan(markdown.indexOf('## 回答 1'))
    expect(markdown.indexOf('## 回答 1')).toBeLessThan(markdown.indexOf('## 提问 2'))
    expect(markdown).toContain('## 回答 1\n\n这是一个示例。')
    expect(markdown).not.toContain('先分析结构')
    expect(markdown).toContain('## 回答 2\n\n总结如下。')
  })

  it('uses zero-padded local date/time components for the default filename', () => {
    expect(defaultVisionExportFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026_01_02-03_04_05.md')
  })

  it('copies one message as Markdown without adding conversation headings', () => {
    expect(buildVisionMessageMarkdown({ role: 'user', content: '**请解释**' })).toBe('**请解释**')
    expect(buildVisionMessageMarkdown({ role: 'assistant', reasoning: '先分析', content: '`答案`' }))
      .toBe('`答案`')
    expect(buildVisionMessageMarkdown({ role: 'assistant', reasoning: '只有思考', content: '' }))
      .toBe('')
  })
})
