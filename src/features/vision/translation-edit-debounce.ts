export const VISION_TRANSLATE_EDIT_DEBOUNCE_MS = 1500

export function scheduleVisionTranslationEdit(callback: () => void): ReturnType<typeof setTimeout> {
  return window.setTimeout(callback, VISION_TRANSLATE_EDIT_DEBOUNCE_MS) as unknown as ReturnType<typeof setTimeout>
}
