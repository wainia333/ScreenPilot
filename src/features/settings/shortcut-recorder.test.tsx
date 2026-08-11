import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShortcutRecorder } from './shortcut-recorder'

describe('ShortcutRecorder', () => {
  it('cancels recording on Escape without bubbling to the window', () => {
    const onChange = vi.fn()
    const windowEscape = vi.fn()
    window.addEventListener('keydown', windowEscape)
    render(<ShortcutRecorder value="F2" label="Translation shortcut" onChange={onChange} />)
    const recorder = screen.getByRole('button', { name: 'Translation shortcut' })
    fireEvent.click(recorder)
    expect(recorder).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(recorder, { key: 'Escape' })
    expect(recorder).toHaveAttribute('aria-pressed', 'false')
    expect(onChange).not.toHaveBeenCalled()
    expect(windowEscape).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowEscape)
  })
})
