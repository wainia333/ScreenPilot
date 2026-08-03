export function primaryProviderKeyDraft(keys: string[] | undefined): string[] | undefined {
  if (keys === undefined) return undefined
  const primary = keys.find((key) => key.trim().length > 0)?.trim()
  return primary === undefined ? [] : [primary]
}
