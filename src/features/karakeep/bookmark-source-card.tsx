import { useState } from 'react'
import type { BookmarkReference, HistoricalBookmark } from './types'
import { safeExternalUrl } from '../vision/citation-links'
import './karakeep.css'
export function BookmarkSourceCard({ source, index, onAsk, onOpen, onCopy, disabled = false, language = 'zh' }: {
  source: BookmarkReference; index: number; onAsk: (source: HistoricalBookmark) => void; onOpen: (url: string) => Promise<unknown>
  onCopy: (url: string) => Promise<unknown>; disabled?: boolean; language?: 'zh' | 'en'
}) {
  const [status, setStatus] = useState('')
  const en = language === 'en'
  const original = source.sourceUrl ? safeExternalUrl(source.sourceUrl) : null
  const saved = source.karakeepUrl ? safeExternalUrl(source.karakeepUrl) : null
  const copyLink = original ?? saved
  const action = async (operation: () => Promise<unknown>, copied = false) => {
    try { await operation(); setStatus(copied ? (en ? 'Link copied' : '链接已复制') : '') }
    catch { setStatus(en ? 'Action failed. Please try again.' : '操作失败，请重试。') }
  }
  return <article className="bookmark-source-card" aria-label={`${index + 1}. ${source.title}`}>
    <div className="bookmark-source-heading"><span>{index + 1}</span><strong>{source.title}</strong></div>
    <p>{source.reason}</p>
    <small>{source.verification === 'content' ? (en ? 'Saved library · content verified' : '收藏库 · 正文证据已校验') : (en ? 'Saved library · metadata only' : '收藏库 · 仅元数据，正文未验证')}</small>
    {source.applicability && <p className="bookmark-applicability">{source.applicability}</p>}
    {source.tags.length > 0 && <div className="bookmark-tags">{source.tags.slice(0, 4).map((tag, i) => <span key={`${tag}-${i}`}>{tag}</span>)}</div>}
    {source.evidence.length > 0 && <details><summary>{en ? 'Content evidence' : '正文依据'}</summary>{source.evidence.map(e => <blockquote key={e.passageId}><pre>{e.quote}</pre></blockquote>)}</details>}
    <div className="bookmark-actions">
      {original && <button type="button" aria-label={`${en ? 'Open original' : '打开原文'}：${source.title}`} onClick={() => void action(() => onOpen(original))}>{en ? 'Original' : '原文'}</button>}
      {saved && <button type="button" aria-label={`${en ? 'View in Karakeep' : '在 Karakeep 中查看'}：${source.title}`} onClick={() => void action(() => onOpen(saved))}>Karakeep</button>}
      {copyLink && <button type="button" aria-label={`${en ? 'Copy link' : '复制链接'}：${source.title}`} onClick={() => void action(() => onCopy(copyLink), true)}>{en ? 'Copy link' : '复制链接'}</button>}
      <button type="button" disabled={disabled} onClick={() => onAsk({ instanceId: source.instanceId, bookmarkId: source.bookmarkId })}>{en ? 'Ask about this' : '基于这篇继续问'}</button>
    </div>
    {status && <span role="status">{status}</span>}
  </article>
}
