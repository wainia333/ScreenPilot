import type { ComponentType } from 'react'
import type { BookmarkSourceCard } from './bookmark-source-card'
import type { BookmarkSearchProgress } from './bookmark-search-progress'
import type { HistoricalBookmark, SourcePolicy } from './types'
export type KnowledgeControlsProps = { mode: SourcePolicy; includeWeb: boolean; configured: boolean; selected: HistoricalBookmark | null; disabled: boolean; onChange: (mode: SourcePolicy, web: boolean) => void; onSettings: () => void; onClear: () => void; language: 'zh' | 'en' }
export function KnowledgeControls({ configured, selected, disabled, onSettings, onClear, language }: KnowledgeControlsProps) {
  const en = language === 'en'
  if (configured && !selected) return null
  return <div className="bookmark-source-controls" onMouseDown={e => e.stopPropagation()}>
    {!configured && <button type="button" disabled={disabled} onClick={onSettings} aria-label={en ? 'Configure KaraKeep' : '配置 KaraKeep'} title={en ? 'Configure KaraKeep' : '配置 KaraKeep'}>⚙</button>}
    {selected && <button type="button" disabled={disabled} onClick={onClear} aria-label={en ? 'Clear selected bookmark' : '取消选中的书签'} title={en ? 'Selected bookmark' : '已选中书签'}>📑 ×</button>}
  </div>
}
export type VisionKnowledgeUi = {
  Controls: ComponentType<KnowledgeControlsProps>
  Source: typeof BookmarkSourceCard
  Progress: typeof BookmarkSearchProgress
}
