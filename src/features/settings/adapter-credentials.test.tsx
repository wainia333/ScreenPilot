import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProvider } from '../../desktop/context'
import { FakeDesktopPort } from '../../desktop/fake-desktop'
import { AdapterCredentials } from './adapter-credentials'

class RecordingDesktop extends FakeDesktopPort {
  readonly adapterKeyWrites: { providerId: string; keys: string[] }[] = []

  override setProviderKeys(providerId: string, keys: string[]): Promise<void> {
    this.adapterKeyWrites.push({ providerId, keys: [...keys] })
    return super.setProviderKeys(providerId, keys)
  }
}

describe('AdapterCredentials', () => {
  afterEach(cleanup)

  it('renders localized credential labels without changing the save contract', () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><AdapterCredentials language="en" /></DesktopProvider>)

    expect(screen.getByText('Service credentials')).toBeInTheDocument()
    expect(screen.getByLabelText('Baidu OCR API Key')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled()
  })

  it('does not replace saved credentials when the draft is blank', async () => {
    const desktop = new RecordingDesktop()
    await desktop.setProviderKeys('adapter-baidu-ocr', ['saved-api-key', 'saved-secret-key'])
    desktop.adapterKeyWrites.length = 0
    render(<DesktopProvider port={desktop}><AdapterCredentials /></DesktopProvider>)

    const section = screen.getByLabelText('百度 OCR API Key').closest('section')
    expect(section).not.toBeNull()
    if (section === null) throw new Error('Baidu OCR credential section is missing')
    const save = within(section).getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)

    expect(desktop.adapterKeyWrites).toHaveLength(0)
    expect(await desktop.providerKeyCount('adapter-baidu-ocr')).toBe(2)
  })

  it('requires every field and preserves the declared field order', async () => {
    const desktop = new RecordingDesktop()
    render(<DesktopProvider port={desktop}><AdapterCredentials /></DesktopProvider>)

    const apiKey = screen.getByLabelText('百度 OCR API Key')
    const secretKey = screen.getByLabelText('百度 OCR Secret Key')
    const section = apiKey.closest('section')
    expect(section).not.toBeNull()
    if (section === null) throw new Error('Baidu OCR credential section is missing')
    const save = within(section).getByRole('button', { name: '保存' })

    fireEvent.change(secretKey, { target: { value: 'secret-key' } })
    await act(async () => {
      fireEvent.click(save)
      await Promise.resolve()
    })
    expect(desktop.adapterKeyWrites).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('请完整填写 百度 OCR 的全部凭据字段')
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'error')

    fireEvent.change(apiKey, { target: { value: ' api-key ' } })
    await act(async () => {
      fireEvent.click(save)
      await Promise.resolve()
    })
    expect(desktop.adapterKeyWrites).toEqual([{
      providerId: 'adapter-baidu-ocr',
      keys: ['api-key', 'secret-key'],
    }])
    expect(apiKey).toHaveValue('')
    expect(secretKey).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent('百度 OCR 凭据已安全保存')
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'success')
  })
})
