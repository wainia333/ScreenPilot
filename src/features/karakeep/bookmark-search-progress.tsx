import type { KnowledgeEvent } from './types'
export function BookmarkSearchProgress({ event, language = 'zh' }: { event: KnowledgeEvent | null; language?: 'zh' | 'en' }) {
  if (!event) return null
  const en = language === 'en'
  const text = {
    searching: en ? 'Searching saved library' : '正在搜索收藏库',
    searched: en ? 'Search completed' : '收藏库搜索完成',
    reading: en ? 'Reading candidate articles' : '正在阅读候选文章',
    selecting: en ? 'Selecting relevant content' : '正在筛选相关内容',
    ready: en ? `${event.summary?.recommendationCount ?? 0} recommendations` : `已筛选 ${event.summary?.recommendationCount ?? 0} 条收藏`,
    warning: event.message ?? (en ? 'Some candidates unavailable' : '部分候选不可用'),
    failed: en ? 'Saved library search failed; see the message below' : '收藏库检索失败，详情见下方',
    cancelled: en ? 'Cancelled' : '已取消',
  }[event.stage]
  const warnings = event.stage === 'ready' ? [...new Set(event.summary?.warnings ?? [])].slice(0, 3) : []
  return <div className="bookmark-progress" role={event.stage === 'failed' ? 'alert' : 'status'} aria-live={event.stage === 'ready' || event.stage === 'failed' ? 'polite' : 'off'}>{text}{warnings.map(warning => <p key={warning}>{warning}</p>)}</div>
}
