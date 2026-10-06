export const defaultCaptureFilename = 'Screenshot_$yyyy-MM-dd_HH-mm-ss$.png'

export function captureFilename(template: string, format: string, date = new Date()): string {
  let control = false
  for (const c of template) if (c.charCodeAt(0) < 32) control = true
  if (!template.trim() || template.length > 180 || /[<>:"/\\|?*]/u.test(template) || control) throw new Error('文件名不能为空，且不能包含路径或 Windows 文件名禁用字符')
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  const tokens: Record<string, string> = { yyyy: pad(date.getFullYear(), 4), yy: pad(date.getFullYear() % 100), MM: pad(date.getMonth() + 1), M: String(date.getMonth() + 1), dd: pad(date.getDate()), d: String(date.getDate()), HH: pad(date.getHours()), H: String(date.getHours()), hh: pad(date.getHours() % 12 || 12), h: String(date.getHours() % 12 || 12), mm: pad(date.getMinutes()), m: String(date.getMinutes()), ss: pad(date.getSeconds()), s: String(date.getSeconds()), zzz: pad(date.getMilliseconds(), 3) }
  const parts = template.split('$')
  if (parts.length % 2 === 0) throw new Error('日期格式需要成对的 $，例如 $yyyy-MM-dd_HH-mm-ss$')
  let name = parts.map((part, index) => {
    if (index % 2 === 0) return part
    if (!part) throw new Error('日期格式不能为空')
    return part.replace(/yyyy|zzz|yy|MM|dd|HH|hh|mm|ss|M|d|H|h|m|s|[A-Za-z]/gu, token => {
      const value = tokens[token]
      if (value === undefined) throw new Error(`不支持的日期符号：${token}`)
      return value
    })
  }).join('').trim()
  name = name.replace(/\.(png|jpe?g|bmp|webp|pdf)$/iu, '')
  if (!name || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw new Error('请使用有效的 Windows 文件名')
  return `${name}.${format.toLowerCase()}`
}

export function filenameIssue(template: string): string | null {
  try { captureFilename(template, 'png'); return null } catch (error) { return error instanceof Error ? error.message : String(error) }
}
