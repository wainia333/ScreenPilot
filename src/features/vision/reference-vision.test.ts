import { describe, expect, it } from 'vitest'
import { safeExternalUrl } from './citation-links'

describe('Vision citation links', () => {
  it('allows only absolute HTTP(S) links for the external opener', () => {
    expect(safeExternalUrl('https://example.com/source')).toBe('https://example.com/source')
    expect(safeExternalUrl('http://127.0.0.1:8080/source')).toBe('http://127.0.0.1:8080/source')
    expect(safeExternalUrl('/inside-vision')).toBeNull()
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,alert(1)')).toBeNull()
  })
})
