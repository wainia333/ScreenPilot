import type { Rect } from './model'
// canvas/smart_selection_anim.py: 90ms OutCubic, interruptible, 40px travel threshold.
export class SmartSelectionAnimation {
  private from: Rect | null = null
  private target: Rect | null = null
  private began = 0
  private running = false
  at(now: number): Rect | null {
    if (!this.from || !this.target || !this.running) return this.target
    const progress = Math.min(1, Math.max(0, (now - this.began) / 90))
    if (progress === 1) { this.running = false; return this.target }
    const t = 1 - (1 - progress) ** 3, a = this.from, b = this.target
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t }
  }
  get active() { return this.running }
  to(rect: Rect, enabled: boolean, now: number) {
    if (this.target && ['x', 'y', 'width', 'height'].every(key => this.target?.[key as keyof Rect] === rect[key as keyof Rect])) return
    const current = this.at(now)
    const travel = current ? Math.abs(current.x - rect.x) + Math.abs(current.y - rect.y) + Math.abs(current.x + current.width - rect.x - rect.width) + Math.abs(current.y + current.height - rect.y - rect.height) : 0
    this.from = current; this.target = { ...rect }; this.began = now; this.running = enabled && !!current && travel >= 40
  }
}
