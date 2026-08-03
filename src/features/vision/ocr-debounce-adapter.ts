type BrowserTimeoutTarget = {
  setTimeout: typeof window.setTimeout
}

export function installOcrDebounceTimingAdapter(target: BrowserTimeoutTarget = window): () => void {
  const originalSetTimeout = target.setTimeout
  const adaptedSetTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) => {
    const delay = timeout === 900 ? 1000 : timeout
    return originalSetTimeout(handler, delay, ...arguments_)
  }) as typeof target.setTimeout
  target.setTimeout = adaptedSetTimeout
  return () => {
    if (target.setTimeout === adaptedSetTimeout) target.setTimeout = originalSetTimeout
  }
}
