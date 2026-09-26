import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdapterCredentials } from './adapter-credentials'

describe('AdapterCredentials', () => {
  it('renders localized controlled fields and configuration state', () => {
    const onDraftChange = vi.fn()
    const onClear = vi.fn()
    render(<AdapterCredentials
      language="en"
      drafts={{}}
      configuredCounts={{ 'adapter-baidu-ocr': 2 }}
      onDraftChange={onDraftChange}
      onClear={onClear}
    />)

    expect(screen.getByText('Service credentials')).toBeInTheDocument()
    expect(screen.getByLabelText('Baidu OCR API Key')).toBeInTheDocument()
    expect(screen.getByText('2 keys stored securely')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear credentials: Baidu OCR' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Clear credentials: Caiyun 2' })).toBeDisabled()
  })

  it('keeps fields controlled and sends a clear action without writing credentials', () => {
    const onDraftChange = vi.fn()
    const onClear = vi.fn()
    render(<AdapterCredentials
      drafts={{ 'adapter-baidu-ocr': 'api-key\nsecret-key' }}
      configuredCounts={{}}
      onDraftChange={onDraftChange}
      onClear={onClear}
    />)

    const section = screen.getByLabelText('百度 OCR API Key').closest('section')
    expect(section).not.toBeNull()
    if (section === null) throw new Error('Baidu OCR credential section is missing')
    expect(within(section).getByLabelText('百度 OCR API Key')).toHaveValue('api-key')
    expect(within(section).getByLabelText('百度 OCR Secret Key')).toHaveValue('secret-key')
    fireEvent.change(within(section).getByLabelText('百度 OCR API Key'), { target: { value: 'new-api-key' } })
    expect(onDraftChange).toHaveBeenCalledWith('adapter-baidu-ocr', 'new-api-key\nsecret-key')
    fireEvent.click(within(section).getByRole('button', { name: '清除凭据：百度 OCR' }))
    expect(onClear).toHaveBeenCalledWith('adapter-baidu-ocr')
  })
})
