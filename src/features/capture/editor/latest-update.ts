// One operation in flight, one replaceable pending update. Pointer/wheel bursts
// must not replay obsolete sizes after the user stops moving.
export class LatestUpdate<T> {
  private pending: T | undefined
  private running: Promise<void> | undefined
  constructor(private readonly apply: (value: T) => Promise<void>) {}
  push(value: T): Promise<void> {
    this.pending = value
    this.running ??= this.drain().finally(() => {
      this.running = undefined
      // A React layout/microtask can enqueue after drain exits but before this
      // completion callback runs. Do not strand that final update.
      if (this.pending !== undefined) return this.push(this.pending)
    })
    return this.running
  }
  private async drain() {
    while (this.pending !== undefined) {
      const value = this.pending; this.pending = undefined
      await this.apply(value)
    }
  }
}
