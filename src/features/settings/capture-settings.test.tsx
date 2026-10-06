import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { SettingsPage } from './settings-page'
import { DEFAULT_SETTINGS } from './defaults'
import { sanitizeSettings, validateSettings } from './sanitize'
import { captureFields } from '../capture/settings-schema'

afterEach(cleanup)

it('defaults old settings to visible pins and preserves hidden pins through main settings roundtrip', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const old = { ...settings, capture: { enabled: true, shortcut: settings.capture.shortcut, nativeOptions: {}, tools: {} } }
  expect(sanitizeSettings(old).capture.pinsVisible).toBe(true)
  settings.capture.pinsVisible = false
  const desktop = new FakeDesktopPort()
  await desktop.saveSettings(settings)
  expect(sanitizeSettings(JSON.parse(JSON.stringify(await desktop.loadSettings())) as unknown).capture.pinsVisible).toBe(false)
})

it('shows both pin close switches enabled by default and persists independent opt-outs in main settings', async () => {
  const desktop = new FakeDesktopPort()
  render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '截图' }))
  fireEvent.click(screen.getByRole('tab', { name: '钉图' }))
  expect(screen.queryByRole('switch', { name: '悬停显示钉图按钮' })).not.toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: '钉图默认显示描边' })).not.toBeInTheDocument()
  const esc = screen.getByRole('switch', { name: 'esc关闭钉图' }), doubleClick = screen.getByRole('switch', { name: '双击关闭钉图' })
  expect(esc).toBeChecked(); expect(doubleClick).toBeChecked()
  fireEvent.click(esc); fireEvent.click(doubleClick)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(async () => expect((await desktop.loadSettings()).capture.nativeOptions).toMatchObject({ pin_escape_close: false, pin_double_click_close: false }))
  const saved = await desktop.loadSettings()
  expect(sanitizeSettings(JSON.parse(JSON.stringify(saved))).capture).toEqual(saved.capture)
  fireEvent.click(screen.getByRole('tab', { name: '基础' })); fireEvent.click(screen.getByRole('tab', { name: '钉图' }))
  expect(screen.getByRole('switch', { name: 'esc关闭钉图' })).not.toBeChecked()
  expect(screen.getByRole('switch', { name: '双击关闭钉图' })).not.toBeChecked()
  fireEvent.click(screen.getByRole('switch', { name: '双击关闭钉图' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(async () => expect((await desktop.loadSettings()).capture.nativeOptions).toMatchObject({ pin_escape_close: false, pin_double_click_close: true }))
})

it('discards retired pin switches and preserves other imported capture options', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.capture.nativeOptions = { pin_hover_buttons: true, pin_auto_border: false, theme_color: '#123456', pin_escape_close: false }
  expect(sanitizeSettings(settings).capture.nativeOptions).toEqual({ theme_color: '#123456', pin_escape_close: false })
})

it('nests JPEG quality below format, defaults to 100 and preserves zero through save and format switches', async () => {
  const desktop = new FakeDesktopPort()
  render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '截图' }))
  fireEvent.click(screen.getByRole('tab', { name: '保存' }))
  const format = screen.getByRole('combobox', { name: '图片格式' })
  expect(screen.queryByRole('spinbutton', { name: '有损格式质量' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '图片格式说明' })).toBeInTheDocument()
  fireEvent.change(format, { target: { value: 'JPG' } })
  const quality = screen.getByRole('spinbutton', { name: '有损格式质量' })
  expect(quality).toHaveValue(100); expect(quality).toHaveAttribute('min', '0'); expect(quality).toHaveAttribute('max', '100')
  expect(quality.closest('.setting-row')).toHaveClass('setting-row--nested')
  expect(format.closest('.setting-row')?.nextElementSibling).toBe(quality.closest('.setting-row'))
  fireEvent.change(quality, { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(async () => expect((await desktop.loadSettings()).capture.nativeOptions).toMatchObject({ screenshot_format: 'JPG', screenshot_quality: 0 }))
  for (const value of ['PDF', 'BMP', 'WEBP', 'PNG']) {
    fireEvent.change(format, { target: { value } })
    expect(screen.queryByRole('spinbutton', { name: '有损格式质量' })).not.toBeInTheDocument()
  }
  fireEvent.change(format, { target: { value: 'JPG' } })
  expect(screen.getByRole('spinbutton', { name: '有损格式质量' })).toHaveValue(0)
})

it('validates the new JPEG quality endpoints during main settings import and preserves existing preferences', () => {
  expect(captureFields.find(field => field.key === 'screenshot_quality')?.default).toBe(100)
  for (const value of [0, 85, 100]) {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.capture.nativeOptions = { screenshot_format: 'JPG', screenshot_quality: value }
    expect(sanitizeSettings(JSON.parse(JSON.stringify(settings))).capture).toEqual(settings.capture)
  }
  for (const value of [-1, 101]) {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.capture.nativeOptions = { screenshot_quality: value }
    expect(sanitizeSettings(settings).capture.nativeOptions).not.toHaveProperty('screenshot_quality')
  }
})

it('removes retired highlighter preferences and layout entries on settings import without losing other tools', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const capture = sanitizeSettings({ ...settings, capture: { ...settings.capture, tools: { highlighter: { width: 15 }, pen: { width: 4 }, layout: [{ key: 'highlighter', mode: 'show' }, { key: 'save', mode: 'show' }, { key: 'confirm', mode: 'show' }] } } }).capture
  expect(capture.tools).toEqual({ pen: { width: 4 }, layout: [{ key: 'save', mode: 'show' }, { key: 'confirm', mode: 'show' }] })
})

it('defaults the pixel grid to on while preserving an explicit saved opt-out and grouped toolbar layout', () => {
  expect(captureFields.find(field => field.key === 'magnifier_grid')?.default).toBe(true)
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.capture.nativeOptions = { magnifier_grid: false }
  settings.capture.tools = { layout: [{ key: 'shape', mode: 'more' }], rect: { width: 4 }, ellipse: { width: 7 } }
  expect(sanitizeSettings(JSON.parse(JSON.stringify(settings))).capture).toEqual(settings.capture)
})

it('preserves capture options, tool styles and layout through main settings import/export sanitization', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.capture.nativeOptions = { magnifier_zoom: 6, gif_fps: 16, screenshot_filename: '演示_$yyyy-MM-dd_HH-mm-ss$.png' }
  settings.capture.tools = { pen: { width: 15, color: '#123456' }, layout: [{ key: 'confirm', mode: 'show' }], lastRegion: { x: -1000, y: 10, width: 640, height: 480 } }
  expect(sanitizeSettings(JSON.parse(JSON.stringify(settings))).capture).toEqual(settings.capture)
  const raw = { ...settings, capture: { ...settings.capture, tools: { ...settings.capture.tools, ocr: true, text: { fontSize: -3, bold: true }, layout: [{ key: 'ocr', mode: 'show' }, { key: 'confirm', mode: 'show' }] } } }
  expect(sanitizeSettings(raw).capture.tools).toEqual({ ...settings.capture.tools, text: { bold: true } })
})

it('shows capture directory errors at the top with the existing toast appearance', async () => {
  const desktop = new FakeDesktopPort()
  vi.spyOn(desktop, 'pickDirectory').mockRejectedValue(new Error('目录选择失败'))
  render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '截图' }))
  expect(document.querySelector('.capture-intro, .capture-art')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '保存' }))
  fireEvent.click(screen.getByRole('button', { name: '保存目录' }))
  const error = await screen.findByRole('alert')
  expect(error).toHaveClass('save-success-toast-region', 'top-notice-fixed')
  expect(error.querySelector('.save-success-toast')).toHaveClass('is-error')
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('migrates old shortcut collisions without changing the existing feature', () => {
  const raw: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS)
  delete raw.capture
  raw.shortcuts = { ...DEFAULT_SETTINGS.shortcuts, vision: 'Alt+Ctrl+S' }
  const settings = sanitizeSettings(raw)
  expect(settings.capture.shortcut).toBe('')
  expect(settings.shortcuts.vision).toBe('Control+Alt+S')
  expect(validateSettings(settings)).toEqual([])
  expect(sanitizeSettings({ ...raw, capture: DEFAULT_SETTINGS.capture }).capture.shortcut).toBe('Control+Alt+S')
})

it('keeps capture tabs accessible and saves recording preferences without a launch header', async () => {
  const desktop = new FakeDesktopPort()
  const persist = vi.spyOn(desktop, 'saveSettingsPatch')
  render(<DesktopProvider port={desktop}><SettingsPage/></DesktopProvider>)
  await act(async () => Promise.resolve())
  fireEvent.click(await screen.findByRole('button', { name: '截图' }))
  expect(screen.getAllByRole('tab')).toHaveLength(7)
  expect(screen.queryByRole('button', { name: '开始截图' })).not.toBeInTheDocument()
  expect(screen.queryByText('使用已保存的设置')).not.toBeInTheDocument()
  expect(screen.getByLabelText('主题色')).toHaveValue('#3388ff')
  fireEvent.click(screen.getByRole('tab', { name: '标注' }))
  expect(screen.queryByLabelText('主题色')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: '基础' }))
  expect(screen.queryByRole('tab', { name: /OCR|剪贴板|翻译/u })).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('tab', { name: '基础' }), { key: 'End' })
  expect(screen.getByRole('tab', { name: '钉图' })).toHaveFocus()
  fireEvent.click(screen.getByRole('tab', { name: '录制' }))
  fireEvent.change(screen.getByRole('combobox', { name: '录制帧率' }), { target: { value: '16' } })
  expect(screen.getByRole('combobox', { name: '录制帧率' })).toHaveValue('16')
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(screen.queryByRole('alert')?.textContent ?? '').toBe('')
  expect(persist).toHaveBeenCalledWith(0, { capture: { nativeOptions: { gif_fps: 16 } } })
  await waitFor(async () => { expect((await desktop.loadSettings()).capture.nativeOptions.gif_fps).toBe(16) })
  expect(screen.queryByRole('button', { name: '开始录制' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: '扫码' }))
  expect(screen.queryByRole('button', { name: '框选扫码' })).not.toBeInTheDocument()
})

it('saves the filename template with settings and updates its preview when format changes', async () => {
  const desktop = new FakeDesktopPort()
  render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '截图' }))
  fireEvent.click(screen.getByRole('tab', { name: '保存' }))
  fireEvent.change(screen.getByLabelText('文件名格式'), { target: { value: '演示_$yyyy-MM-dd$.png' } })
  fireEvent.change(screen.getByRole('combobox', { name: '图片格式' }), { target: { value: 'JPG' } })
  expect(screen.getByLabelText('文件名预览').textContent).toMatch(/演示_\d{4}-\d{2}-\d{2}\.jpg/u)
  expect(screen.queryByText('记住上次使用的扩展名')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(async () => expect((await desktop.loadSettings()).capture.nativeOptions.screenshot_filename).toBe('演示_$yyyy-MM-dd$.png'))
})
