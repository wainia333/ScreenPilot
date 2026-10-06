import type { CaptureScene } from './scene'
import type { CaptureSnapshot, Rect } from './model'

// Send only styles changed by this session, so open pins cannot reset other tools.
export function capturePreferences(scene: CaptureScene, baseline: CaptureSnapshot['tools'], lastRegion?: Rect) {
  const tools: CaptureSnapshot['tools'] = {}
  for (const key of Object.keys(scene.styles) as (keyof typeof scene.styles)[]) {
    if (JSON.stringify(scene.styles[key]) !== JSON.stringify(baseline[key])) tools[key] = { ...scene.styles[key] }
  }
  if (scene.snapshot.tools.layout && JSON.stringify(scene.snapshot.tools.layout) !== JSON.stringify(baseline.layout)) tools.layout = scene.snapshot.tools.layout
  if (lastRegion) tools.lastRegion = lastRegion
  return { options: { ...scene.pendingOptions }, tools }
}
