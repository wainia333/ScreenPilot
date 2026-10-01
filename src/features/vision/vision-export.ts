export type VisionExportMessage = {
  sources?: import('../karakeep/types').BookmarkReference[]
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  imagePreview?: string
}

export type VisionExportOptions = {
  messages: readonly VisionExportMessage[]
  imageDataUrl?: string
  appLabel?: string
  language?: 'zh' | 'en'
}

const pad = (value: number) => String(value).padStart(2, '0')

// Reasoning is a display-only stream and must never leave the Vision surface.
export function buildVisionMessageMarkdown(
  message: VisionExportMessage,
): string {
  const escape = (text: string) => text.replace(/[\\[\]]/gu, '\\$&')
  const sources = (message.sources ?? []).slice(0, 5).map((source, index) => {
    const url = source.sourceUrl ?? source.karakeepUrl
    const heading = url && /^https?:\/\//u.test(url) ? `[${escape(source.title)}](<${url.replace(/[<>\r\n]/gu, '')}>)` : escape(source.title)
    const evidence = source.evidence.slice(0, 3).map(e => `> ${e.quote.replace(/\n/gu, '\n> ')}`).join('\n\n')
    return [`${index + 1}. ${heading}`, source.reason, source.applicability, source.verification === 'metadata' ? '仅元数据，正文未验证' : '', evidence].filter(Boolean).join('\n\n')
  })
  return [message.content.trim(), sources.length ? `收藏库来源：\n\n${sources.join('\n\n')}` : ''].filter(Boolean).join('\n\n')
}

export function defaultVisionExportFileName(date = new Date()): string {
  return `${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}-${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}.md`
}

export function buildVisionMarkdown({
  messages,
  imageDataUrl = '',
  appLabel = '',
  language = 'zh',
}: VisionExportOptions): string {
  const labels = language === 'zh'
    ? {
        title: 'Vision 对话',
        screenshot: '截图',
        source: '来源',
        question: '提问',
        answer: '回答',
      }
    : {
        title: 'Vision Conversation',
        screenshot: 'Screenshot',
        source: 'Source',
        question: 'Question',
        answer: 'Answer',
      }

  const sections = [`# ${labels.title}`]
  const source = appLabel.replace(/[\r\n]+/gu, ' ').trim()
  if (source) sections.push(`> ${labels.source}: ${source}`)
  const hasMessageImages = messages.some(message => !!message.imagePreview?.trim())
  if (imageDataUrl.trim() && !hasMessageImages) {
    sections.push(`![${labels.screenshot}](${imageDataUrl.trim()})`)
  }

  let questionIndex = 0
  let answerIndex = 0
  messages.forEach((message) => {
    const body = buildVisionMessageMarkdown(message)
    const image = message.imagePreview?.trim() ?? ''
    if (!body && !image) return

    const heading = message.role === 'user'
      ? `${labels.question} ${++questionIndex}`
      : `${labels.answer} ${++answerIndex}`
    const content = [image ? `![${labels.screenshot}](${image})` : '', body]
      .filter(Boolean)
      .join('\n\n')
    sections.push(`## ${heading}\n\n${content}`)
  })

  return `${sections.join('\n\n').trimEnd()}\n`
}
