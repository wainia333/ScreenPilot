import { useEffect, useState } from 'react'
import { Camera, Film, FolderOpen, PencilRuler, Pin, ScanLine, ScanQrCode } from 'lucide-react'
import { useDesktop } from '../../../desktop/use-desktop'
import { SettingGroup, SettingRow, Toggle, SelectField, TextField } from '../../../shared/ui/controls'
import { SettingsTabs } from '../../../shared/ui/settings-tabs'
import { TopNotice } from '../../../shared/ui/top-notice'
import { HelpTooltip } from '../../../shared/ui/help-tooltip'
import { ShortcutRecorder } from '../shortcut-recorder'
import type { AppSettings } from '../types'
import type { CaptureSettings } from '../../capture/types'
import { captureFields } from '../../capture/settings-schema'
import { colorFormats } from '../../capture/color-formats'
import { captureFilename } from '../../capture/filename'
import '../../capture/capture-settings.css'

type CaptureTab = 'basic' | 'annotation' | 'scroll' | 'record' | 'scan' | 'save' | 'pin'

const tabs = [
  { value: 'basic', zh: '基础', en: 'General', icon: Camera },
  { value: 'annotation', zh: '标注', en: 'Annotate', icon: PencilRuler },
  { value: 'scroll', zh: '长截图', en: 'Scroll', icon: ScanLine },
  { value: 'record', zh: '录制', en: 'Record', icon: Film },
  { value: 'scan', zh: '扫码', en: 'Scan', icon: ScanQrCode },
  { value: 'save', zh: '保存', en: 'Save', icon: FolderOpen },
  { value: 'pin', zh: '钉图', en: 'Pin', icon: Pin },
] as const

const formatDescriptions = [
  { name: 'PNG', zh: '无损，完整保留截图像素，支持透明背景。适合文字、软件界面和标注截图，兼容性好。', en: 'Lossless; preserves screenshot pixels and supports transparency. Suitable for text, app interfaces and annotations, with broad compatibility.' },
  { name: 'JPG', zh: '有损，不支持透明背景。适合照片或更注重文件大小的截图。质量 0–100：数值越高，画质通常越好、文件越大。', en: 'Lossy; does not support transparency. Suitable for photos or smaller files. Quality 0–100: higher values generally improve image quality and increase file size.' },
  { name: 'BMP', zh: '无损，完整保留截图像素。压缩较少，文件通常较大，适合需要位图文件的场景。', en: 'Lossless; preserves screenshot pixels. Uses little compression and generally produces larger files. Suitable when a bitmap file is required.' },
  { name: 'WEBP', zh: '当前为无损编码，支持透明背景。文件可能比 PNG 更小，部分旧软件不支持。', en: 'Currently uses lossless encoding and supports transparency. Files may be smaller than PNG; some older apps do not support it.' },
  { name: 'PDF', zh: '无损，将截图按原始分辨率放入单页 PDF，适合分享和打印。', en: 'Lossless; places the screenshot at its original resolution in a single-page PDF. Suitable for sharing and printing.' },
] as const

function FilenameField({ value, format, label, onChange, zh }: { value: string; format: string; label: string; onChange: (value: string) => void; zh: boolean }) {
  const [date, setDate] = useState(() => new Date())
  useEffect(() => { const timer = setInterval(() => setDate(new Date()), 1000); return () => clearInterval(timer) }, [])
  let preview = '', issue = ''
  try { preview = captureFilename(value, format, date) } catch (error) { issue = String(error instanceof Error ? error.message : error) }
  return <div className="capture-filename">
    <TextField value={value} label={label} issuePath="capture.nativeOptions.screenshot_filename" onChange={onChange} />
    <div className="capture-filename-preview" aria-label={zh ? '文件名预览' : 'Filename preview'} title={preview || issue}>{zh ? '预览：' : 'Preview: '}{issue || preview}</div>
  </div>
}

export function CaptureSettingsNavigation({ value, onChange, language }: {
  value: string; onChange: (value: string) => void; language: 'zh' | 'en'
}) {
  return <SettingsTabs value={value} onChange={onChange} label={language === 'zh' ? '截图设置分类' : 'Capture settings'}
    panelId="capture-settings-panel" options={tabs.map(({ value, zh, en, icon: Icon }) => ({ value, label: language === 'zh' ? zh : en, icon: <Icon size={15} /> }))} />
}

export function CaptureSection({ settings, onChange, tab: selectedTab, saving }: {
  settings: AppSettings; onChange: (next: AppSettings) => void; tab: string; saving: boolean
}) {
  const desktop = useDesktop()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const zh = settings.language === 'zh'
  const t = (cn: string, en: string) => zh ? cn : en
  const current = settings.capture
  const tab = selectedTab as CaptureTab
  const lossyFormat = current.nativeOptions.screenshot_format === 'JPG'
  const update = (patch: Partial<CaptureSettings>) => onChange({ ...settings, capture: { ...current, ...patch } })
  const pickDirectory = async () => {
    setWorking(true); setError('')
    try { const path = await desktop.pickDirectory(); if (path) updateOption('screenshot_save_path', path) }
    catch (cause) { setError(String(cause)) }
    finally { setWorking(false) }
  }
  const updateOption = (key: string, value: string | number | boolean) => update({ nativeOptions: { ...current.nativeOptions, [key]: value } })
  return <div id="capture-settings-panel" className="capture-settings-panel" role="tabpanel" aria-label={tabs.find((item) => item.value === tab)?.[zh ? 'zh' : 'en']}>
    {error && <TopNotice message={error} language={settings.language} tone="error" portal onDismiss={() => setError('')} />}
    {tab === 'basic' && <SettingGroup title={t('捕获与快捷键', 'Capture & shortcuts')}>
      <SettingRow label={t('启用截图', 'Enable capture')}><Toggle checked={current.enabled} label={t('启用截图', 'Enable capture')} onChange={(enabled) => update({ enabled })}/></SettingRow>
      <SettingRow label={t('截图快捷键', 'Capture shortcut')}><ShortcutRecorder value={current.shortcut} label={t('截图快捷键', 'Capture shortcut')} recordingLabel={t('请按快捷键', 'Press a shortcut')} issuePath="capture.shortcut" onChange={(shortcut) => update({ shortcut })}/></SettingRow>
    </SettingGroup>}
    <SettingGroup title={tabs.find((item) => item.value === tab)?.[zh ? 'zh' : 'en'] ?? ''}>
      {captureFields.filter((field) => field.tab === tab && (field.key !== 'screenshot_quality' || lossyFormat)).map((field) => {
        const label = field[zh ? 'zh' : 'en']
        const value = current.nativeOptions[field.key] ?? field.default
        return <SettingRow key={field.key} label={label} nested={field.key === 'screenshot_quality'}
          labelAction={field.key === 'screenshot_format' ? <HelpTooltip label={t('图片格式说明', 'Image format help')}><div className="capture-format-help">{formatDescriptions.map(format => <p key={format.name}><strong>{format.name}｜</strong>{format[zh ? 'zh' : 'en']}</p>)}</div></HelpTooltip> : undefined}
          {...(field.kind === 'filename' ? { description: t('日期使用 $yyyy-MM-dd_HH-mm-ss$；zzz 为毫秒。\n扩展名随图片格式变化。', 'Date: $yyyy-MM-dd_HH-mm-ss$; zzz = milliseconds.\nExtension follows image format.') } : field.key === 'screenshot_quality' ? { description: t('100 画质最好，0 画质最差。', '100 = best quality; 0 = lowest quality.') } : {})}>
          {typeof value === 'boolean' ? <Toggle checked={value} label={label} onChange={(v) => updateOption(field.key, v)}/>
            : field.kind === 'color-formats' ? <div className="capture-color-formats">{colorFormats(value).map((format, index, formats) => <div key={format.name}>
              <Toggle checked={format.enabled} label={format.name} onChange={enabled => updateOption(field.key, JSON.stringify(colorFormats(formats.map(item => item.name === format.name ? { ...item, enabled } : item))))} /><span>{format.name}</span>
              <button type="button" className="icon-button" aria-label={`${t('上移', 'Move up ')}${format.name}`} disabled={index === 0} onClick={() => { const previous = formats[index - 1]; if (previous) { formats[index - 1] = format; formats[index] = previous; updateOption(field.key, JSON.stringify(formats)) } }}>↑</button>
            </div>)}</div>
            : field.kind === 'shortcut' ? <SelectField value={String(value)} label={label} options={gestureOptions(zh)} onChange={(v) => updateOption(field.key, v)}/>
            : field.kind === 'filename' ? <FilenameField value={String(value)} format={String(current.nativeOptions.screenshot_format ?? 'PNG')} label={label} zh={zh} onChange={v => updateOption(field.key, v)} />
            : field.choices ? <SelectField value={String(value)} label={label} options={field.choices.map((v) => ({ value: String(v), label: choiceLabel(v, zh) }))} onChange={(v) => updateOption(field.key, typeof field.default === 'number' ? Number(v) : v)}/>
            : field.kind === 'directory' ? <button type="button" className="path-button" aria-label={label} title={String(value) || t('图片 / ScreenPilot', 'Pictures / ScreenPilot')} disabled={working || saving} onClick={() => void pickDirectory()}><FolderOpen size={15}/><span>{String(value) || t('图片 / ScreenPilot', 'Pictures / ScreenPilot')}</span></button>
            : field.kind === 'color' ? <input className="capture-color-input" type="color" aria-label={label} value={String(value)} onChange={(e) => updateOption(field.key, e.target.value)}/>
            : typeof field.default === 'number' ? <input className="text-field capture-number-input" type="number" aria-label={label} min={field.min} max={field.max} step={field.step ?? 1} value={Number(value)} onChange={(e) => { const v = Number(e.target.value), step = field.step ?? 1; if (Number.isFinite(v)) updateOption(field.key, Math.min(field.max ?? v, Math.max(field.min ?? v, Math.round(v / step) * step))) }}/>
            : <TextField value={String(value)} label={label} issuePath={`capture.nativeOptions.${field.key}`} onChange={(v) => updateOption(field.key, v)}/>}
        </SettingRow>
      })}
      <div className="capture-note"><PencilRuler size={16}/><span>{tab === 'record'
        ? t('框选后进入录制，支持暂停、画笔、裁剪与变速。在回放的保存对话框选择 GIF 或 MP4；不录制声音。', 'Select an area to record. Pause, draw, trim and adjust speed; choose GIF or MP4 when saving playback. Audio is not recorded.')
        : tab === 'basic' ? t('框选后直接在原位置标注，工具条跟随选区。双击或完成按钮复制图片，Esc 取消。', 'Annotate in place with the toolbar beside the selection. Double-click or Finish to copy; Esc to cancel.')
        : tab === 'annotation' ? t('各工具的颜色、粗细、箭头样式和工具条排列可在截图工具条中调整并记住。', 'Adjust tool colors, widths, arrow styles and toolbar order directly in the capture toolbar.')
        : tab === 'pin' ? t('保存后，关闭方式立即应用到已打开的钉图。Esc 只作用于当前钉图，菜单中的关闭始终可用。', 'Saved close preferences apply to open pins immediately. Esc acts on the current pin; the Close menu item is always available.')
        : t('修改后点击页面下方「保存」，下一次操作使用新设置。', 'Save at the bottom of this page to apply preferences to the next operation.')}</span></div>
    </SettingGroup>
  </div>
}

function gestureOptions(zh: boolean) {
  const modifiers = ['win', 'ctrl', 'shift', 'alt', 'ctrl+shift', 'ctrl+alt', 'ctrl+win', 'shift+alt', 'shift+win', 'alt+win']
  const buttons = [['left', '左键', 'Left'], ['right', '右键', 'Right'], ['middle', '中键', 'Middle'], ['x1', '侧键 1', 'Side 1'], ['x2', '侧键 2', 'Side 2']]
  return [{ value: '', label: zh ? '关闭' : 'Off' }, ...modifiers.flatMap((modifier) => buttons.map(([key, cn, en]) => ({
    value: `${modifier}+drag${key ?? 'left'}`,
    label: `${modifier.replace(/\b\w/gu, (letter) => letter.toUpperCase()).replaceAll('+', ' + ')} + ${zh ? `${cn ?? ''}拖动` : `${en ?? ''} drag`}`,
  })))]
}

function choiceLabel(value: string | number | boolean, zh: boolean): string {
  const names: Record<string, [string, string]> = {
    auto: ['自动', 'Automatic'], mss: ['标准捕获', 'Standard capture'], hdr: ['HDR 捕获', 'HDR capture'],
    window: ['窗口', 'Windows'], element: ['窗口与控件', 'Windows and elements'],
    all: ['全部', 'All'], corners: ['四角', 'Corners'], none: ['无', 'None'],
    small: ['小', 'Small'], medium: ['中', 'Medium'], large: ['大', 'Large'],
    shadow: ['阴影', 'Shadow'], border: ['描边', 'Border'],
    0: ['跟随系统缩放', 'System scale'],
  }
  return names[String(value)]?.[zh ? 0 : 1] ?? String(value)
}
