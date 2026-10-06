export type NoticeLanguage = 'zh' | 'en'
export type NoticeMessage = { summary: string; details?: string }

// Presentation only: keep the original error for diagnostics and leave retry,
// persistence, conflict detection and error categories with their owners.
export function conciseNotice(message: string, language: NoticeLanguage = 'zh'): NoticeMessage {
  const raw = message.trim()
  if (!raw) return { summary: '' }
  const cleaned = raw.replace(/(^|[：:]\s*)(?:(?:Error|TypeError|RuntimeError):\s*)+/giu, '$1').trim()
  const en = language === 'en'
  const limit = en ? 96 : 44
  const text = (zh: string, english: string) => en ? english : zh
  const heading = /^([^\n：:]{2,24}(?:失败|未完成|failed|failure))[：:]/iu.exec(cleaned)?.[1]
  const first = cleaned.split(/\r?\n/u).find(line => line.trim())?.trim() ?? cleaned
  const rules: [RegExp, string, string][] = [
    [/SETTINGS_CONFLICT/u, '设置已被更新，请重新加载后再试', 'Settings changed elsewhere. Reload and try again.'],
    [/credential (?:store|vault) unavailable|vault.*(?:unavailable|locked)/iu, '无法保存密钥，请稍后重试', 'Cannot save credentials. Try again shortly.'],
    [/Invalid settings patch|Settings import is invalid|invalid settings field/iu, '配置格式不兼容，请检查配置后重试', 'Incompatible settings. Check the configuration and try again.'],
    [/disk (?:is )?full|not enough space|no space left|磁盘空间不足|磁盘已满|os error 112/iu, '磁盘空间不足，请清理后重试', 'Not enough disk space. Free some space and try again.'],
    [/permission denied|access (?:is )?denied|EACCES|os error 5\b|拒绝访问|没有写入权限/iu, '权限不足，请检查文件或目录权限', 'Access denied. Check the file or folder permissions.'],
    [/\bHTTP\s*401\b|\b401\s*(?:Unauthorized|Client Error)|invalid[_ -]api[_ -]key|unauthorized|无效的.*密钥|API Key.*无效/iu, '认证失败，请检查 API Key', 'Authentication failed. Check the API key.'],
    [/\bHTTP\s*403\b|\b403\s*(?:Forbidden|Client Error)|权限不足.*接口/iu, '当前账号无权访问，请检查账号权限', 'Access is not allowed for this account.'],
    [/\bHTTP\s*429\b|\b429\s*(?:Too Many|Client Error)|rate.?limit|请求过于频繁/iu, '请求过于频繁，请稍后重试', 'Too many requests. Try again shortly.'],
    [/timed?\s*out|timeout|超时/iu, '请求超时，请稍后重试', 'Request timed out. Try again shortly.'],
    [/failed to fetch|error sending request|network.*(?:error|unreachable)|connection (?:refused|reset)|ECONNREFUSED|无法连接服务器/iu, '连接失败，请检查网络或服务地址', 'Connection failed. Check the network or service address.'],
    [/Windows 媒体组件不可用|Media Foundation.*(?:unavailable|not installed)/iu, '缺少 Windows 媒体组件，无法导出视频', 'Windows media components are unavailable. Video export failed.'],
    [/快捷键.*(?:冲突|占用)|(?:shortcut|hotkey).*(?:conflict|already registered)/iu, '快捷键已被占用，请更换组合', 'Shortcut already in use. Choose another combination.'],
  ]
  const rule = rules.find(([pattern]) => pattern.test(cleaned))
  let summary = rule ? text(rule[1], rule[2]) : first
  if (rule && heading && !summary.startsWith(heading)) summary = `${heading}${en ? ': ' : '：'}${summary}`

  const technical = /(?:\bat\s+\S+\s*\(|\b(?:HRESULT|os error|panicked at)\b|^\s*[<{[]|https?:\/\/|[A-Za-z]:\\)/iu.test(summary)
  if (!rule && technical) summary = heading ? `${heading}${text('，请重试或查看详情', '. Try again or view details.')}` : text('操作未完成，请重试或查看详情', 'Operation failed. Try again or view details.')
  if (Array.from(summary).length > limit) {
    const sentence = /^.*?[。！？]|^.*?[.!?](?:\s|$)/u.exec(summary)?.[0]?.trim()
    if (sentence) summary = sentence
    if (Array.from(summary).length > limit) summary = `${Array.from(summary).slice(0, limit - 1).join('').trimEnd()}…`
  }
  // Independent startup warnings are separated by blank lines. Do not count
  // stack frames or "Caused by" paragraphs as additional user-facing issues.
  const blocks = cleaned.split(/\r?\n\s*\r?\n/u).filter(block => !/^\s*(?:at\b|Caused by|Stack trace)/iu.test(block))
  if (blocks.length > 1) summary = text('有多项提示，请查看详情', 'Multiple notices. View details.')
  return summary === cleaned ? { summary } : { summary, details: raw }
}
