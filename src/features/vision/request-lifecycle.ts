export type VisionStreamIdentity = {
  imageId: string
  requestId: string
}

export type VisionResultIdentity = {
  requestId: string
}

export function matchesVisionStream(
  activeImageId: string,
  activeRequestId: string | null,
  payload: VisionStreamIdentity,
): boolean {
  return payload.imageId === activeImageId && payload.requestId === activeRequestId
}

export function matchesVisionResult(
  activeRequestId: string | null,
  requestId: string,
  result: VisionResultIdentity,
): boolean {
  return activeRequestId === requestId && result.requestId === requestId
}

export function mergeVisionResponse(existing: string, canonical: string): string {
  if (!existing) return canonical
  if (!canonical) return existing
  if (existing === canonical) return existing
  return canonical
}

export function appendVisionError(existing: string, error: string, label?: string): string {
  const normalized = error.trim()
  if (!normalized) return existing
  const marker = `⚠️ ${label ? `${label}: ` : ''}${normalized}`
  if (existing.includes(marker) || existing.includes(normalized)) return existing
  return existing ? `${existing}\n\n${marker}` : marker
}

export class VisionRequestLifecycle {
  private sequence = 0
  private activeRequestId: string | null = null
  private settledRequestId: string | null = null

  begin(): string {
    const requestId = `vision-${++this.sequence}`
    this.activeRequestId = requestId
    this.settledRequestId = null
    return requestId
  }

  invalidate(): number {
    this.sequence += 1
    this.activeRequestId = null
    this.settledRequestId = null
    return this.sequence
  }

  matchesStream(activeImageId: string, payload: VisionStreamIdentity): boolean {
    return matchesVisionStream(activeImageId, this.activeRequestId, payload)
  }

  matchesResult(requestId: string, result: VisionResultIdentity): boolean {
    return matchesVisionResult(this.activeRequestId, requestId, result)
  }

  isCurrentInvalidation(sequence: number): boolean {
    return this.sequence === sequence && this.activeRequestId === null
  }

  isCurrent(requestId: string): boolean {
    return this.activeRequestId === requestId
  }

  acceptResult(requestId: string, resultRequestId: string): boolean {
    if (!matchesVisionResult(this.activeRequestId, requestId, { requestId: resultRequestId })) {
      return false
    }
    this.settledRequestId = requestId
    return true
  }

  settleError(requestId: string): boolean {
    if (!this.isCurrent(requestId)) return false
    this.settledRequestId = requestId
    return true
  }

  canFinalize(requestId: string): boolean {
    return this.activeRequestId === requestId && this.settledRequestId === requestId
  }
}
