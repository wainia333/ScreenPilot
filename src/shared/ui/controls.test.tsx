import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Segmented } from './controls'

function ThemeSelector() {
  const [value, setValue] = useState<'system' | 'light' | 'dark'>('system')
  return (
    <Segmented
      value={value}
      label="Theme"
      options={[
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
      onChange={setValue}
    />
  )
}

describe('Segmented', () => {
  it('uses roving focus and the WAI-ARIA radio keyboard pattern', () => {
    render(<ThemeSelector />)
    const system = screen.getByRole('radio', { name: 'System' })
    const light = screen.getByRole('radio', { name: 'Light' })
    const dark = screen.getByRole('radio', { name: 'Dark' })
    expect(system).toHaveAttribute('tabindex', '0')
    expect(light).toHaveAttribute('tabindex', '-1')

    system.focus()
    fireEvent.keyDown(system, { key: 'ArrowLeft' })
    expect(dark).toBeChecked()
    expect(document.activeElement).toBe(dark)
    expect(dark).toHaveAttribute('tabindex', '0')
    expect(system).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(dark, { key: 'Home' })
    expect(system).toBeChecked()
    expect(document.activeElement).toBe(system)
  })
})
