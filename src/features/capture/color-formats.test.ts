import { describe, expect, it } from 'vitest'
import { colorFormats, formatColor } from './color-formats'
describe('upstream color format contract', () => {
  it('defaults to RGB followed by HEX and tolerates corrupted saved JSON', () => {
    expect(colorFormats('').filter(item => item.enabled).map(item => item.name)).toEqual(['RGB', 'HEX'])
    expect(colorFormats('{bad')).toEqual(colorFormats(null))
  })
  it('preserves order, rejects unknown templates, deduplicates and enables at least one format', () => {
    const result = colorFormats([{ name: 'CSS hsl()', enabled: false }, { name: 'CSS hsl()', enabled: true }, { name: 'custom', enabled: true }])
    expect(result).toHaveLength(5); expect(result[0]).toEqual({ name: 'CSS hsl()', enabled: true })
  })
  it('formats fixed RGB, CSS, hex and achromatic HSL values', () => {
    expect(formatColor(255, 0, 0, 'CSS hsl()')).toBe('hsl(0, 100%, 50%)')
    expect(formatColor(128, 128, 128, 'CSS hsl()')).toBe('hsl(0, 0%, 50%)')
    expect(formatColor(12, 128, 0, 'HEX')).toBe('#0C8000')
    expect(formatColor(12, 128, 0, 'HEX without #')).toBe('0C8000')
    expect(formatColor(12, 128, 0, 'CSS rgb()')).toBe('rgb(12, 128, 0)')
  })
})
