// Port of settings/color_formats.py. Templates are fixed; only order/enabled vary.
export const colorFormatNames = ['RGB', 'CSS rgb()', 'HEX', 'HEX without #', 'CSS hsl()'] as const
export type ColorFormatName = typeof colorFormatNames[number]
export type ColorFormat = { name: ColorFormatName; enabled: boolean }
export function colorFormats(raw: unknown): ColorFormat[] {
  let items: unknown = raw
  if (typeof raw === 'string') { try { items = JSON.parse(raw) } catch { items = null } }
  const result: ColorFormat[] = [], seen = new Set<string>()
  if (Array.isArray(items)) for (const entry of items as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>, name = item.name
    if (typeof name !== 'string' || !colorFormatNames.includes(name as ColorFormatName) || seen.has(name)) continue
    result.push({ name: name as ColorFormatName, enabled: Boolean(item.enabled) }); seen.add(name)
  }
  if (!result.length) return colorFormatNames.map(name => ({ name, enabled: name === 'RGB' || name === 'HEX' }))
  for (const name of colorFormatNames) if (!seen.has(name)) result.push({ name, enabled: false })
  if (!result.some(item => item.enabled) && result[0]) result[0].enabled = true
  return result
}
export function formatColor(red: number, green: number, blue: number, name: ColorFormatName): string {
  const rgb = `${red}, ${green}, ${blue}`, hex = [red, green, blue].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  if (name === 'RGB') return rgb
  if (name === 'CSS rgb()') return `rgb(${rgb})`
  if (name === 'HEX') return `#${hex}`
  if (name === 'HEX without #') return hex
  const r = red / 255, g = green / 255, b = blue / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, light = (max + min) / 2
  let hue = 0
  if (delta) hue = (max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60
  const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0
  return `hsl(${Math.floor(hue)}, ${Math.round(saturation * 100)}%, ${Math.round(light * 100)}%)`
}
