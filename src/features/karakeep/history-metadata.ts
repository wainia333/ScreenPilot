import type { BookmarkReference, SearchRunSummary } from './types'
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown, length: number): string { return typeof value === 'string' ? value.slice(0, length) : '' }
function link(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null } catch { return null }
}
export function cleanSources(value: unknown): BookmarkReference[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).flatMap((item: unknown) => {
    const r = record(item)
    if (!text(r.instanceId, 2048) || !/^[A-Za-z0-9_-]{1,128}$/u.test(text(r.bookmarkId, 256))) return []
    return [{ instanceId: text(r.instanceId, 2048), bookmarkId: text(r.bookmarkId, 128), title: text(r.title, 300),
      contentType: text(r.contentType, 40), sourceUrl: link(r.sourceUrl), karakeepUrl: link(r.karakeepUrl),
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 8).map((v: unknown) => text(v, 80)) : [], reason: text(r.reason, 600),
      evidence: Array.isArray(r.evidence) ? r.evidence.slice(0, 3).map((e: unknown) => { const p = record(e); return { passageId: text(p.passageId, 100), quote: text(p.quote, 1800), contentVersion: typeof p.contentVersion === 'string' ? text(p.contentVersion, 256) : null } }) : [],
      verification: r.verification === 'content' ? 'content' as const : 'metadata' as const, applicability: typeof r.applicability === 'string' ? text(r.applicability, 400) : null, retrievedAt: text(r.retrievedAt, 80),
    }]
  })
}
export function cleanSummary(value: unknown): SearchRunSummary | undefined {
  const r = record(value)
  if (typeof r.runId !== 'string') return undefined
  return { runId: text(r.runId, 100), requestedMode: r.requestedMode === 'fts' || r.requestedMode === 'semantic' ? r.requestedMode : 'hybrid', effectiveMode: text(r.effectiveMode, 20) || 'unknown', status: text(r.status, 40),
    readCount: typeof r.readCount === 'number' ? Math.min(8, Math.max(0, r.readCount)) : 0, recommendationCount: typeof r.recommendationCount === 'number' ? Math.min(5, Math.max(0, r.recommendationCount)) : 0,
    warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 20).map((s: unknown) => text(s, 500)) : [] }
}
