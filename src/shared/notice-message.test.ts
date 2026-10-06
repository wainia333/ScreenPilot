import { expect, it } from 'vitest'
import { conciseNotice } from './notice-message'

it.each([
  ['保存失败：Error: Access is denied. (os error 5)', '保存失败：权限不足，请检查文件或目录权限'],
  ['配置导入失败：Settings import is invalid: expected object', '配置导入失败：配置格式不兼容，请检查配置后重试'],
  ['SETTINGS_CONFLICT current revision 3', '设置已被更新，请重新加载后再试'],
  ['HTTP 401 Unauthorized: response body', '认证失败，请检查 API Key'],
  ['HTTP 403 Forbidden: response body', '当前账号无权访问，请检查账号权限'],
  ['HTTP 429 Too Many Requests: response body', '请求过于频繁，请稍后重试'],
  ['Error: request timed out after 120000ms', '请求超时，请稍后重试'],
  ['Error: error sending request for url (https://service.invalid/v1)', '连接失败，请检查网络或服务地址'],
  ['No space left on device', '磁盘空间不足，请清理后重试'],
  ['Windows 媒体组件不可用：HRESULT(0x80004005)', '缺少 Windows 媒体组件，无法导出视频'],
  ['Global shortcut already registered: Ctrl+S', '快捷键已被占用，请更换组合'],
])('summarizes a known failure while preserving its diagnostics: %s', (raw, summary) => {
  expect(conciseNotice(raw)).toEqual({ summary, details: raw })
})

it('preserves useful short copy and localizes English summaries', () => {
  expect(conciseNotice('设置已保存')).toEqual({ summary: '设置已保存' })
  expect(conciseNotice('Error: 没有录制帧')).toEqual({ summary: '没有录制帧' })
  expect(conciseNotice('Error: Error: 没有录制帧')).toEqual({ summary: '没有录制帧' })
  expect(conciseNotice('编号为 401 的模型不可用')).toEqual({ summary: '编号为 401 的模型不可用' })
  expect(conciseNotice('Error: request timed out', 'en').summary).toBe('Request timed out. Try again shortly.')
  expect(conciseNotice('  ')).toEqual({ summary: '' })
})

it('bounds unknown messages and keeps stacks, paths and multiple issues behind details', () => {
  const prose = '未能完成本次操作。' + '原因说明和排查步骤。'.repeat(30)
  expect(conciseNotice(prose)).toEqual({ summary: '未能完成本次操作。', details: prose })
  const long = '🙂'.repeat(100)
  expect(Array.from(conciseNotice(long).summary)).toHaveLength(44)
  expect(conciseNotice(long).details).toBe(long)
  const stack = '截图失败：HRESULT(0x80004005)\n    at capture (runtime.js:10)'
  expect(conciseNotice(stack)).toEqual({ summary: '截图失败，请重试或查看详情', details: stack })
  const notices = '配置已恢复为默认值。\n\nAltSnap 启动失败。'
  expect(conciseNotice(notices)).toEqual({ summary: '有多项提示，请查看详情', details: notices })
  expect(conciseNotice('<html>Bad gateway</html>').summary).not.toContain('<html>')
})
