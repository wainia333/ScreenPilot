import type { ProviderSettings } from '../features/settings/types'

export type ProviderCommandArgs = {
  provider: ProviderSettings
  keys?: string[]
}

export function providerCommandArgs(
  provider: ProviderSettings,
  keys?: string[],
): ProviderCommandArgs {
  if (keys === undefined) return { provider }
  const primary = keys.find((key) => key.trim().length > 0)?.trim()
  return { provider, keys: primary === undefined ? [] : [primary] }
}
