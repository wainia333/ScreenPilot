import { Check, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { stableMarkdown } from './stable-markdown'

function childText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childText).join('')
  return ''
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = childText(children).replace(/\n$/u, '')
  return (
    <div className="code-block">
      <button type="button" aria-label="复制代码" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) })}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
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
