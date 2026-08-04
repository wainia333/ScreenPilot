export function safeExternalUrl(href: string): string | null {
  if (!/^https?:\/\//iu.test(href.trim())) return null
  try {
    const parsed = new URL(href, window.location.href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}
