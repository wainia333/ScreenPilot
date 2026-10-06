export type ScanTextPart = { text: string; href?: string }
// Keep decoded content as text. Only explicit web links become anchors.
export function scanTextParts(text: string): ScanTextPart[] {
  const parts: ScanTextPart[] = []
  const links = /https?:\/\/[^\s<>"'，。；！？（）【】]+|www\.[^\s<>"'，。；！？（）【】]+/giu
  let cursor = 0
  for (const match of text.matchAll(links)) {
    const start = match.index
    let value = match[0].replace(/[.,;!?]+$/u, '')
    while (value.endsWith(')') && (value.match(/\)/gu)?.length ?? 0) > (value.match(/\(/gu)?.length ?? 0)) value = value.slice(0, -1)
    const href = /^www\./iu.test(value) ? `https://${value}` : value
    try {
      const url = new URL(href)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue
    } catch { continue }
    if (start > cursor) parts.push({ text: text.slice(cursor, start) })
    parts.push({ text: value, href }); cursor = start + value.length
  }
  if (cursor < text.length || !parts.length) parts.push({ text: text.slice(cursor) })
  return parts
}
