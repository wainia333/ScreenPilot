import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { SettingsPage } from '../settings/settings-page'
import { DEFAULT_KARAKEEP_SYSTEM_PROMPT, DEFAULT_SETTINGS } from '../settings/defaults'
import { sanitizeSettings } from '../settings/sanitize'
import { buildVisionMessageMarkdown } from '../vision/vision-export'
import { BookmarkSourceCard } from './bookmark-source-card'
import { BookmarkSearchProgress } from './bookmark-search-progress'
import { cleanSources } from './history-metadata'
import { latestReferences, modelMessages, type BookmarkReference, type KnowledgeEvent } from './types'
import { useVisionKnowledge } from './use-vision-knowledge'
const transport = vi.hoisted(() => ({ listener: null as ((event: KnowledgeEvent) => void) | null, dispose: vi.fn() }))
vi.mock('../../vendor/screenshot/api/tauri', () => ({ api: { onVisionKnowledge: (callback: (event: KnowledgeEvent) => void) => { transport.listener = callback; return Promise.resolve(transport.dispose) } } }))
const source: BookmarkReference = {
  instanceId: 'https://saved.example/', bookmarkId: 'compose', title: 'Karakeep Docker Compose 安装', contentType: 'link',
  sourceUrl: 'https://article.example/install', karakeepUrl: 'https://saved.example/dashboard/preview/compose', tags: ['Docker'],
  reason: '提供 Compose 部署步骤', evidence: [{ passageId: 'p1', quote: '配置 NEXTAUTH_SECRET 后启动容器。' }], verification: 'content', retrievedAt: '2026-10-01T00:00:00Z',
}
afterEach(cleanup)
describe('Native Karakeep UI contracts', () => {
  it('keeps partial reading warnings visible with the actual recommendation count', () => {
    render(<BookmarkSearchProgress event={{ requestId: 'vision-1', imageId: '', stage: 'ready', summary: { runId: 'run-1', requestedMode: 'hybrid', effectiveMode: 'unknown', status: 'ready', readCount: 1, recommendationCount: 1, warnings: ['部分正文读取失败', '部分正文读取失败', '正文已截断'] } }} />)
    expect(screen.getByRole('status')).toHaveTextContent('已筛选 1 条收藏')
    expect(screen.getAllByText('部分正文读取失败')).toHaveLength(1)
    expect(screen.getByText('正文已截断')).toBeVisible()
  })
  it('loads old settings and strips model payloads to explicit role/content', () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, karakeep: undefined }).karakeep.defaultSearchMode).toBe('fts')
    expect(sanitizeSettings({ karakeep: { enabled: true, visionPolicy: 'only' } }).karakeep.systemPrompt).toBe(DEFAULT_KARAKEEP_SYSTEM_PROMPT)
    const messages = [{ role: 'assistant' as const, content: '找到一篇', sources: [source], reasoning: 'private', imagePreview: 'large' }]
    expect(modelMessages(messages)).toEqual([{ role: 'assistant', content: '找到一篇' }])
    expect(latestReferences(messages)).toEqual([{ instanceId: source.instanceId, bookmarkId: 'compose' }])
    const markdown = buildVisionMessageMarkdown(messages[0] ?? { role: 'assistant', content: '' })
    expect(markdown).toContain(source.title); expect(markdown).toContain(source.sourceUrl); expect(markdown).toContain(source.evidence[0]?.quote)
    expect(markdown).not.toContain('private')
  })
  it('keeps source order after sanitizing history and drops unrelated metadata', () => {
    const restored = cleanSources([{ ...source, apiKey: 'must-drop', transcript: ['tool'] }, { ...source, bookmarkId: '../wrong' }])
    expect(restored).toHaveLength(1); expect(JSON.stringify(restored)).not.toContain('must-drop'); expect(JSON.stringify(restored)).not.toContain('transcript')
    expect(latestReferences([{ role: 'assistant', content: 'answer', sources: restored }])[0]?.bookmarkId).toBe('compose')
  })
  it('passes structured source IDs from card actions and supports evidence disclosure', async () => {
    const ask = vi.fn(), open = vi.fn(() => Promise.resolve()), copy = vi.fn(() => Promise.resolve())
    render(<BookmarkSourceCard source={source} index={0} onAsk={ask} onOpen={open} onCopy={copy} />)
    fireEvent.click(screen.getByRole('button', { name: '基于这篇继续问' }))
    expect(ask).toHaveBeenCalledWith({ instanceId: source.instanceId, bookmarkId: 'compose' })
    fireEvent.click(screen.getByRole('button', { name: `打开原文：${source.title}` })); expect(open).toHaveBeenCalledWith(source.sourceUrl)
    fireEvent.click(screen.getByRole('button', { name: `复制链接：${source.title}` })); await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('链接已复制'))
    fireEvent.click(screen.getByText('正文依据')); expect(screen.getByText(source.evidence[0]?.quote ?? '')).toBeVisible()
  })
  it('rejects late knowledge events when cancelled or superseded', async () => {
    let current = 'vision-1'; const update = vi.fn()
    const { result, unmount } = renderHook(() => useVisionKnowledge(id => id === current, update))
    await act(async () => { await Promise.resolve() })
    const event: KnowledgeEvent = { requestId: 'vision-1', imageId: '', stage: 'ready', sources: [source] }
    act(() => transport.listener?.(event)); expect(update).toHaveBeenCalledTimes(1)
    current = 'vision-2'; act(() => transport.listener?.(event)); expect(update).toHaveBeenCalledTimes(1)
    act(() => result.current.reset()); expect(result.current.event).toBeNull()
    current = ''; act(() => transport.listener?.(event)); expect(update).toHaveBeenCalledTimes(1)
    unmount(); expect(transport.dispose).toHaveBeenCalled()
  })
  it('tests unsaved credentials without persistence and clears the draft after saving', async () => {
    const desktop = new FakeDesktopPort()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'KaraKeep' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Karakeep 实例地址' }), { target: { value: 'https://saved.example/sub/' } })
    fireEvent.change(screen.getByLabelText('Karakeep API Key'), { target: { value: 'draft-private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const testToast = await screen.findByRole('status', { name: '只读API连接成功' })
    expect(testToast.parentElement).toBe(document.querySelector('.settings-window'))
    expect(document.querySelector('.karakeep-settings .status-banner')).not.toBeInTheDocument()
    expect(desktop.karakeepTestCalls).toEqual([{ baseUrl: 'https://saved.example/sub/', apiKey: 'draft-private-key' }])
    expect((await desktop.loadSettings()).karakeep.baseUrl).toBe(''); expect(desktop.importedSecretsSaveCalls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByLabelText('Karakeep API Key')).toHaveValue(''))
    await waitFor(() => expect(screen.getByLabelText('Karakeep API Key')).toHaveAttribute('placeholder', '************'))
    expect(desktop.importedSecretsSaveCalls[0]?.secrets.integrations).toEqual({ karakeep: ['draft-private-key'] })
    expect(JSON.stringify(await desktop.loadSettings())).not.toContain('draft-private-key')
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(desktop.karakeepTestCalls).toHaveLength(2))
    expect(desktop.karakeepTestCalls[1]).toEqual({ baseUrl: 'https://saved.example/sub/', apiKey: undefined })
    expect(screen.getByLabelText('Karakeep API Key')).toHaveValue('')
  })
  it('saves, reloads and restores the KaraKeep system prompt using the normal settings transaction', async () => {
    const desktop = new FakeDesktopPort()
    const { unmount } = render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'KaraKeep' }))
    expect(screen.getByRole('combobox', { name: '调用策略' })).toHaveValue('auto')
    const prompt = screen.getByRole('textbox', { name: 'KaraKeep 系统提示词' })
    const reset = screen.getByRole('button', { name: '恢复默认：KaraKeep 系统提示词' })
    expect(prompt).toHaveValue(DEFAULT_KARAKEEP_SYSTEM_PROMPT)
    expect(reset).toBeDisabled()
    fireEvent.change(prompt, { target: { value: '优先推荐能直接在线编辑 SVG 的工具。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeDisabled())
    expect((await desktop.loadSettings()).karakeep.systemPrompt).toBe('优先推荐能直接在线编辑 SVG 的工具。')
    unmount()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'KaraKeep' }))
    expect(screen.getByRole('textbox', { name: 'KaraKeep 系统提示词' })).toHaveValue('优先推荐能直接在线编辑 SVG 的工具。')
    fireEvent.click(screen.getByRole('button', { name: '恢复默认：KaraKeep 系统提示词' }))
    expect(screen.getByRole('textbox', { name: 'KaraKeep 系统提示词' })).toHaveValue(DEFAULT_KARAKEEP_SYSTEM_PROMPT)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeDisabled())
    expect((await desktop.loadSettings()).karakeep.systemPrompt).toBe(DEFAULT_KARAKEEP_SYSTEM_PROMPT)
  })
  it('shows failed connection tests in the upper floating alert without persisting a draft', async () => {
    const desktop = new FakeDesktopPort()
    vi.spyOn(desktop, 'testKarakeep').mockRejectedValue('只读 API 鉴权失败')
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'KaraKeep' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Karakeep 实例地址' }), { target: { value: 'https://saved.example/' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const testToast = await screen.findByRole('alert', { name: '只读 API 鉴权失败' })
    expect(testToast.parentElement).toBe(document.querySelector('.settings-window'))
    expect(testToast.querySelector('.save-success-toast')).toHaveClass('is-error')
    expect((await desktop.loadSettings()).karakeep.baseUrl).toBe('')
  })
  it('rolls settings back and preserves the credential draft when vault saving fails', async () => {
    const desktop = new FakeDesktopPort(); desktop.importedSecretsSaveError = 'vault failure'
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'KaraKeep' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Karakeep 实例地址' }), { target: { value: 'https://saved.example/' } })
    fireEvent.change(screen.getByLabelText('Karakeep API Key'), { target: { value: 'keep-draft' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('vault failure'))
    expect((await desktop.loadSettings()).karakeep.baseUrl).toBe(''); expect(screen.getByLabelText('Karakeep API Key')).toHaveValue('keep-draft')
  })
})
