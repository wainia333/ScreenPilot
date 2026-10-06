import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { conciseNotice, type NoticeLanguage } from '../notice-message'
import './top-notice.css'

function NoticeBody({ message, language, children }: { message: string; language: NoticeLanguage; children?: ReactNode }) {
  const notice = conciseNotice(message, language), [expanded, setExpanded] = useState(false), detailsId = useId()
  return <div className="top-notice-body">
    <div className="top-notice-heading">
      <span className="top-notice-message">{notice.summary}</span>
      {notice.details && <> <button type="button" className="top-notice-details-toggle" data-capture-interactive aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>{language === 'en' ? 'Details' : '详情'}</button></>}
    </div>
    {Boolean(children) && <div className="top-notice-actions" data-capture-interactive>{children}</div>}
    {notice.details && <div id={detailsId} className="top-notice-details" data-capture-interactive hidden={!expanded}><pre>{notice.details}</pre></div>}
  </div>
}

export function NoticeContent({ message, language = 'zh', onDismiss, children }: {
  message: string; language?: NoticeLanguage; onDismiss?: (() => void) | undefined; children?: ReactNode
}) {
  return <div className="top-notice-content">
    <NoticeBody key={message} message={message} language={language}>{children}</NoticeBody>
    {onDismiss && <button type="button" className="top-notice-dismiss" data-capture-interactive aria-label={language === 'en' ? 'Dismiss notification' : '关闭提示'} onClick={onDismiss}><X size={14} aria-hidden="true" /></button>}
  </div>
}

export function TopNotice({ message, tone = 'status', sequence, phase = 'visible', onDismiss, children, portal = false, style, language = 'zh' }: {
  message?: string | null | undefined; tone?: 'status' | 'error' | undefined; sequence?: number | undefined; phase?: 'visible' | 'leaving' | undefined;
  onDismiss?: (() => void) | undefined; children?: ReactNode; portal?: boolean; style?: CSSProperties | undefined; language?: NoticeLanguage
}) {
  const notice = <div className={`save-success-toast-region${portal ? ' top-notice-fixed' : ''}`} style={style}
    role={tone === 'error' ? 'alert' : 'status'} aria-live={tone === 'error' ? 'assertive' : 'polite'} aria-atomic="true" aria-label={message ? conciseNotice(message, language).summary : undefined}>
    {message && <div key={sequence ?? message} className={`save-success-toast${tone === 'error' ? ' is-error' : ''}${phase === 'leaving' ? ' is-leaving' : ''}`}
      data-toast-sequence={sequence} data-toast-phase={phase}>
      <NoticeContent message={message} language={language} onDismiss={onDismiss}>{children}</NoticeContent>
    </div>}
  </div>
  return portal ? createPortal(notice, document.body) : notice
}
