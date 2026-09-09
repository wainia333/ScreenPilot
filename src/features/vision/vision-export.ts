export type VisionExportMessage = {
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
  return message.content.trim()
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
