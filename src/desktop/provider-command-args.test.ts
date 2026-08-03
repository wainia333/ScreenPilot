import { describe, expect, it } from 'vitest'
import { providerCommandArgs } from './provider-command-args'
import type { ProviderSettings } from '../features/settings/types'

const provider: ProviderSettings = {
  id: 'provider',
  name: 'Provider',
  baseUrl: 'https://example.com/v1',
  keyCount: 1,
  availableModels: [],
  enabledModels: [],
}

describe('provider command arguments', () => {
  it('omits the key override when the draft field is untouched', () => {
    const args = providerCommandArgs(provider)
    expect(Object.prototype.hasOwnProperty.call(args, 'keys')).toBe(false)
    expect(args.provider).toEqual(provider)
  })

  it('serializes an explicit empty override without falling back', () => {
    const args = providerCommandArgs(provider, [])
    expect(args).toEqual({ provider, keys: [] })
  })

  it('copies only the normalized primary override payload', () => {
    const keys = ['  draft-primary ', 'backup-secret']
    const args = providerCommandArgs(provider, keys)
    keys[0] = 'changed-after-call'
    expect(args.keys).toEqual(['draft-primary'])
  })
})
