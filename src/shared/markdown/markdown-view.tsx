import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { stableMarkdown } from './stable-markdown'
import { copyToClipboard } from '../../vendor/screenshot/utils/clipboard'

function childText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childText).join('')
  return ''
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState<{ text: string; status: 'copied' | 'failed' } | null>(null)
  const request = useRef(0)
  const mounted = useRef(true)
  const text = childText(children).replace(/\n$/u, '')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current += 1
    }
  }, [])
  const copy = async () => {
    const currentRequest = request.current + 1
    request.current = currentRequest
    const succeeded = await copyToClipboard(text)
    if (!mounted.current || currentRequest !== request.current) return
    setFeedback({ text, status: succeeded ? 'copied' : 'failed' })
    if (succeeded) {
      window.setTimeout(() => {
        if (mounted.current && currentRequest === request.current) setFeedback(null)
      }, 1200)
    }
  }
  return (
    <div className="code-block">
      <button type="button" aria-label="复制代码" onClick={() => void copy()}>
        {feedback?.text === text && feedback.status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {feedback?.text === text && feedback.status === 'failed'
        ? <span role="alert" className="sr-only">复制失败，请检查剪贴板权限</span>
        : null}
      <pre><code>{text}</code></pre>
    </div>
  )
}

export function MarkdownView({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) =>
            className?.includes('language-') === true ? <CodeBlock>{children}</CodeBlock> : <code>{children}</code>,
        }}
      >
        {streaming ? stableMarkdown(content) : content}
      </ReactMarkdown>
    </div>
  )
}
