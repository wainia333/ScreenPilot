export const POPUP_MENU_WIDTH = 286
export const POPUP_MENU_SHADOW = 8
export function popupMenuHeight(items: number, separators: number) { return 18 + items * 38 + separators * 11 }
export function popupMenuScale(scale: number, width: number, height: number, menuHeight: number) {
  return Math.max(0.01, Math.min(scale, width / (POPUP_MENU_WIDTH + 2 * POPUP_MENU_SHADOW), height / (menuHeight + 2 * POPUP_MENU_SHADOW)))
}
