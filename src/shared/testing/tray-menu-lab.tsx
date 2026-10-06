import { useState } from 'react'
import { TrayMenu, type TrayMenuModel } from '../../app/tray-menu'
import { popupMenuHeight, popupMenuScale } from '../ui/popup-menu-layout'

export default function TrayMenuLab() {
  const parameters = new URLSearchParams(location.search)
  const [visible, setVisible] = useState(!parameters.has('hidden'))
  const enabled = !parameters.has('empty')
  const en = parameters.has('en')
  const list: TrayMenuModel['items'] = [
    { id: 'translator', label: en ? 'Text translation' : '文本翻译', shortcut: 'F2', checked: null, enabled: true, separator: false },
    { id: 'vision', label: 'Vision', shortcut: 'F3', checked: null, enabled: true, separator: false },
    { id: 'screenshot', label: en ? 'OCR translation' : 'OCR翻译', shortcut: 'F4', checked: null, enabled: true, separator: false },
    { id: 'optimizer', label: en ? 'Prompt optimization' : '提示词优化', shortcut: 'Ctrl + Alt + P', checked: null, enabled: true, separator: false },
    { id: 'capture', label: en ? 'Capture / Record / Scan' : '截图 / 录制 / 扫码', shortcut: 'Ctrl + Alt + S', checked: null, enabled: true, separator: false },
    { id: 'pins', label: en ? 'Show / Hide pins' : '显示 / 隐藏钉图', shortcut: '', checked: enabled && visible, enabled, separator: false },
    { id: 'altsnap', label: 'AltSnap', shortcut: 'Alt + 鼠标左键', checked: null, enabled: true, separator: false },
    { id: '', label: '', shortcut: '', checked: null, enabled: false, separator: true },
    { id: 'settings', label: en ? 'Settings' : '设置', shortcut: '', checked: null, enabled: true, separator: false },
    { id: '', label: '', shortcut: '', checked: null, enabled: false, separator: true },
    { id: 'restart_admin', label: en ? 'Restart (administrator)' : '重启（管理员）', shortcut: '', checked: null, enabled: true, separator: false },
    { id: 'quit', label: en ? 'Quit' : '退出', shortcut: '', checked: null, enabled: true, separator: false },
  ]
  const scale = popupMenuScale(Number(parameters.get('scale') ?? 100) / 100, innerWidth, innerHeight, popupMenuHeight(10, 2))
  return <TrayMenu model={{ generation: 1, items: list, scale, accent: '#3388ff' }} onAction={id => { if (id === 'pins') setVisible(v => !v) }} onDismiss={() => { /* fixture stays open */ }} />
}
