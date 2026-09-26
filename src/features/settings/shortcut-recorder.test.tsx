import { fireEvent, render, screen } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShortcutRecorder } from './shortcut-recorder'

afterEach(cleanup)

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

  it.each([
    [{ key: ' ', code: 'Space', ctrlKey: true }, 'Control+Space'],
    [{ key: '+', code: 'Equal', shiftKey: true }, 'Shift+Equal'],
    [{ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true }, 'Shift+ArrowLeft'],
    [{ key: 'F24', code: 'F24', altKey: true }, 'Alt+F24'],
  ])('persists parser-compatible tokens for %s', (event, expected) => {
    const onChange = vi.fn()
    render(<ShortcutRecorder value="F2" label="Translation shortcut" onChange={onChange} />)
    const recorder = screen.getByRole('button', { name: 'Translation shortcut' })
    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, event)
    expect(onChange).toHaveBeenCalledWith(expected)
  })

  it('records modifier-only shortcuts only for AltSnap', () => {
    const onChange = vi.fn()
    render(<ShortcutRecorder value="Alt" label="AltSnap shortcut" allowModifierOnly onChange={onChange} />)
    const recorder = screen.getByRole('button', { name: 'AltSnap shortcut' })
    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, { key: 'Control', code: 'ControlLeft', ctrlKey: true })
    fireEvent.keyUp(recorder, { key: 'Control', code: 'ControlLeft', ctrlKey: true })
    expect(onChange).toHaveBeenCalledWith('Control')
  })
})
