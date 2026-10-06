import { expect, it } from 'vitest'
import { POPUP_MENU_WIDTH, POPUP_MENU_SHADOW, popupMenuHeight, popupMenuScale } from './popup-menu-layout'

it('fits the entire menu at every UI size on small and fractional-DPI screens', () => {
  const height = popupMenuHeight(10, 3)
  expect(height).toBe(431)
  for (const dpi of [1, 1.25, 1.5, 2]) for (const desired of [0.75, 1, 1.25, 1.5, 2]) for (const screen of [{ width: 1280 / dpi, height: 720 / dpi }, { width: 320, height: 240 }]) {
    const scale = popupMenuScale(desired, screen.width, screen.height, height)
    expect((POPUP_MENU_WIDTH + 2 * POPUP_MENU_SHADOW) * scale).toBeLessThanOrEqual(screen.width + 1e-7)
    expect((height + 2 * POPUP_MENU_SHADOW) * scale).toBeLessThanOrEqual(screen.height + 1e-7)
  }
})
