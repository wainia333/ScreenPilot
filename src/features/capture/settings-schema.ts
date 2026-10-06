import schema from '../../../src-tauri/src/domain/capture-settings-schema.json' with { type: 'json' }
type Option = string | number | boolean
type CaptureTools = import('./editor/model').CaptureSnapshot['tools']
export function sanitizeCaptureTools(raw: unknown): CaptureTools {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!object(raw)) return {}
  const tools = ['cursor', 'pen', 'mosaic', 'spotlight', 'arrow', 'number', 'rect', 'ellipse', 'text', 'eraser']
  const numeric: Record<string, [number, number]> = { width: [1, 200], opacity: [0, 1], radius: [0, 100], block: [2, 200], fontSize: [6, 1000], outlineWidth: [0, 1] }
  const choices: Record<string, string[]> = { line: ['solid', 'dashed', 'dashed_dense'], arrow: ['single', 'double', 'hollow', 'line', 'line_double', 'triangle', 'triangle_double', 'bar', 'bar_arrow'], mosaic: ['pixelate', 'blur'], mode: ['freehand', 'rect'], number: ['solid', 'hollow_bg', 'hollow_all', 'no_circle'] }
  const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
  const result: Record<string, unknown> = {}
  for (const tool of tools) {
    const style = raw[tool]; if (!object(style)) continue
    result[tool] = Object.fromEntries(Object.entries(style).filter(([key, value]) => {
      if (numeric[key]) return finite(value, ...numeric[key])
      if (choices[key]) return typeof value === 'string' && choices[key].includes(value)
      if (['color', 'backgroundColor', 'outlineColor', 'shadowColor'].includes(key)) return typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(value)
      if (['fill', 'bold', 'italic', 'underline', 'background', 'outline', 'shadow'].includes(key)) return typeof value === 'boolean'
      return key === 'font' && typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\n\r"]/u.test(value)
    }))
  }
  const r = raw.lastRegion
  if (object(r) && finite(r.x, -100000, 100000) && finite(r.y, -100000, 100000) && finite(r.width, 0, 32768) && finite(r.height, 0, 32768)) result.lastRegion = { x: r.x, y: r.y, width: r.width, height: r.height }
  if (Array.isArray(raw.layout)) {
    const seen = new Set<string>(), keys = [...tools, 'long_screenshot', 'save', 'scan_code', 'gif', 'shape', 'undo', 'redo', 'cancel', 'pin', 'confirm', 'copy']
    result.layout = raw.layout.filter(v => {
      if (!object(v) || typeof v.key !== 'string' || !keys.includes(v.key) || seen.has(v.key) || !['show', 'more', 'hide'].includes(String(v.mode))) return false
      seen.add(v.key); return true
    }).map(v => ({ key: (v as Record<string, unknown>).key, mode: (v as Record<string, unknown>).mode }))
  }
  return result
}
export type CaptureField = {
  key: string; tab: string; zh: string; en: string; default: Option
  choices?: Option[]; kind?: string; min?: number; max?: number; step?: number
}
export const captureFields: CaptureField[] = schema
export function captureGestureIssues(options: Record<string, Option>): { key: string; message: string }[] {
  const used = new Set<string>()
  return captureFields.filter((field) => field.kind === 'shortcut').flatMap((field) => {
    const value = String(options[field.key] ?? field.default).toLowerCase()
    if (!value) return []
    const parts = value.split('+')
    const button = parts.pop() ?? ''
    if (!/^drag(left|right|middle|x1|x2)$/u.test(button) || parts.length < 1 || parts.length > 2 || new Set(parts).size !== parts.length || parts.some((key) => !['ctrl', 'alt', 'shift', 'win'].includes(key))) {
      return [{ key: field.key, message: '请选择有效的鼠标快捷键 / Choose a valid mouse gesture' }]
    }
    const normalized = [...parts.sort(), button].join('+')
    if (used.has(normalized)) return [{ key: field.key, message: '鼠标快捷键重复 / Mouse gesture is already in use' }]
    used.add(normalized)
    return []
  })
}
export function sanitizeCaptureOptions(raw: unknown): Record<string, Option> {
  if (!raw || typeof raw !== 'object') return {}
  const values = raw as Record<string, unknown>
  return Object.fromEntries(captureFields.flatMap((field) => {
    const value = values[field.key]
    if (typeof value !== typeof field.default) return []
    if (field.choices && !field.choices.includes(value as Option)) return []
    if (typeof value === 'number' && (!Number.isFinite(value) || value < (field.min ?? -Infinity) || value > (field.max ?? Infinity))) return []
    if (typeof value === 'string' && (value.length > 2048 || (field.kind === 'color' && !/^#[0-9a-f]{6}$/iu.test(value)))) return []
    return [[field.key, value as Option]]
  }))
}
