export type SafeFloatingDragApi = {
  startDragging: () => Promise<void>
}

export type SafeFloatingDragInvoke = (
  command: string,
  args: Record<string, never>,
) => Promise<unknown>

export function installSafeFloatingDrag(
  api: SafeFloatingDragApi,
  invokeStart: SafeFloatingDragInvoke,
): () => void {
  const originalStartDragging = api.startDragging
  const safeStartDragging = async () => {
    await invokeStart('vision_start_safe_drag', {})
  }
  api.startDragging = safeStartDragging
  return () => {
    if (api.startDragging === safeStartDragging) api.startDragging = originalStartDragging
  }
}
