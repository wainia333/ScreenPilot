import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { SettingsPage } from './settings-page'

class ClosingDesktop extends FakeDesktopPort {
  hides = 0

  override hideWindow(): Promise<void> {
    this.hides += 1
    return Promise.resolve()
  }
}

class AdministratorDesktop extends ClosingDesktop {
  override permissionStatus() {
    return Promise.resolve({
      platform: 'windows' as const,
      screenCapture: true,
      accessibility: true,
      administrator: true,
    })
  }
}

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('offers save, discard and continue choices before closing dirty settings', async () => {
    const desktop = new ClosingDesktop()
    render(<DesktopProvider port={desktop}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    fireEvent.click(await screen.findByRole('radio', { name: '深色' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    const dialog = screen.getByRole('dialog', { name: '保存更改后关闭？' })
    expect(dialog).toHaveTextContent('保存并关闭')
    expect(dialog).toHaveTextContent('放弃更改')
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃更改' }))
    expect(desktop.hides).toBe(1)
  })

  it('keeps the save action in the lower-right footer', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    const save = screen.getByRole('button', { name: '保存' })
    expect(save.closest('footer')).toHaveClass('settings-footer')
  })

  it('labels the screenshot translation settings section as OCR', async () => {
    render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    await act(async () => Promise.resolve())
    expect(screen.getByRole('button', { name: 'OCR' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'OCR/截图翻译' })).not.toBeInTheDocument()
  })

  it('shows the current process administrator status', async () => {
    const standard = render(<DesktopProvider port={new ClosingDesktop()}><SettingsPage /></DesktopProvider>)
    expect(await screen.findByRole('status')).toHaveTextContent('标准用户身份')
    standard.unmount()
    render(<DesktopProvider port={new AdministratorDesktop()}><SettingsPage /></DesktopProvider>)
    expect(await screen.findByRole('status')).toHaveTextContent('管理员身份')
  })
})
