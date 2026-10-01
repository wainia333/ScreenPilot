export type SourcePolicy = 'off' | 'auto' | 'only'
export type SearchMode = 'fts' | 'semantic' | 'hybrid'
export type KarakeepConfig = { enabled: boolean; baseUrl: string; instanceId: string; defaultSearchMode: SearchMode; visionPolicy: SourcePolicy; systemPrompt: string }
export type HistoricalBookmark = { instanceId: string; bookmarkId: string }
export type Evidence = { passageId: string; quote: string; contentVersion?: string | null }
export type BookmarkReference = HistoricalBookmark & {
  title: string; contentType: string; sourceUrl?: string | null; karakeepUrl?: string | null; tags: string[]
  reason: string; evidence: Evidence[]; verification: 'content' | 'metadata'; applicability?: string | null; retrievedAt: string
}
export type SearchRunSummary = { runId: string; requestedMode: SearchMode; effectiveMode: string; status: string; readCount: number; recommendationCount: number; warnings: string[] }
export type KnowledgeRequest = { mode: SourcePolicy; references: HistoricalBookmark[]; selected?: HistoricalBookmark; includeWeb: boolean }
export type KnowledgeEvent = {
  requestId: string; imageId: string; stage: 'searching' | 'searched' | 'reading' | 'selecting' | 'ready' | 'warning' | 'failed' | 'cancelled'
  sources?: BookmarkReference[] | null; summary?: SearchRunSummary; message?: string
}
export type KnowledgeMessage = { role: 'user' | 'assistant'; content: string; sources?: BookmarkReference[]; searchSummary?: SearchRunSummary }
export function latestReferences(messages: readonly KnowledgeMessage[]): HistoricalBookmark[] {
  const sources = [...messages].reverse().find(m => m.role === 'assistant' && m.sources?.length)?.sources ?? []
  return sources.slice(0, 5).map(({ instanceId, bookmarkId }) => ({ instanceId, bookmarkId }))
}
export function modelMessages(messages: readonly KnowledgeMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages.map(({ role, content }) => ({ role, content }))
}
