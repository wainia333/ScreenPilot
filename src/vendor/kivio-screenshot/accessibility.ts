export type AccessibleRect = { x: number; y: number; width: number; height: number }
export type AccessibleViewport = { w: number; h: number }
export type AccessibleArrow = { x1: number; y1: number; x2: number; y2: number }

const MIN_REGION_SIZE = 10

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function defaultKeyboardRegion(viewport: AccessibleViewport): AccessibleRect {
  const width = Math.max(MIN_REGION_SIZE, Math.round(viewport.w * 0.5))
  const height = Math.max(MIN_REGION_SIZE, Math.round(viewport.h * 0.5))
  return {
    x: Math.max(0, Math.round((viewport.w - width) / 2)),
    y: Math.max(0, Math.round((viewport.h - height) / 2)),
    width: Math.min(viewport.w, width),
    height: Math.min(viewport.h, height),
  }
}

export function adjustKeyboardRegion(
  rect: AccessibleRect,
  viewport: AccessibleViewport,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  resize: boolean,
  step = 10,
): AccessibleRect {
  if (resize) {
    const widthDelta = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
    const heightDelta = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
    return {
      ...rect,
      width: clamp(rect.width + widthDelta, MIN_REGION_SIZE, Math.max(MIN_REGION_SIZE, viewport.w - rect.x)),
      height: clamp(rect.height + heightDelta, MIN_REGION_SIZE, Math.max(MIN_REGION_SIZE, viewport.h - rect.y)),
    }
  }
  const xDelta = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const yDelta = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  return {
    ...rect,
    x: clamp(rect.x + xDelta, 0, Math.max(0, viewport.w - rect.width)),
    y: clamp(rect.y + yDelta, 0, Math.max(0, viewport.h - rect.height)),
  }
}

export function nextWindowIndex(length: number, currentIndex: number, direction: -1 | 1): number {
  if (length <= 0) return -1
  if (currentIndex < 0 || currentIndex >= length) return direction > 0 ? 0 : length - 1
  return (currentIndex + direction + length) % length
}

export function defaultKeyboardArrow(viewport: AccessibleViewport): AccessibleArrow {
  return {
    x1: Math.round(viewport.w * 0.25),
    y1: Math.round(viewport.h * 0.65),
    x2: Math.round(viewport.w * 0.75),
    y2: Math.round(viewport.h * 0.35),
  }
}

export function adjustKeyboardArrow(
  arrow: AccessibleArrow,
  viewport: AccessibleViewport,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  pan: boolean,
  step = 10,
): AccessibleArrow {
  const xDelta = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const yDelta = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  if (!pan) {
    return {
      ...arrow,
      x2: clamp(arrow.x2 + xDelta, 0, viewport.w),
      y2: clamp(arrow.y2 + yDelta, 0, viewport.h),
    }
  }

  const clampedXDelta = clamp(xDelta, -Math.min(arrow.x1, arrow.x2), viewport.w - Math.max(arrow.x1, arrow.x2))
  const clampedYDelta = clamp(yDelta, -Math.min(arrow.y1, arrow.y2), viewport.h - Math.max(arrow.y1, arrow.y2))
  return {
    x1: arrow.x1 + clampedXDelta,
    y1: arrow.y1 + clampedYDelta,
    x2: arrow.x2 + clampedXDelta,
    y2: arrow.y2 + clampedYDelta,
  }
}
