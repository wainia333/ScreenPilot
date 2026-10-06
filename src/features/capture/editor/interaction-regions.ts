// Child popovers and draggable toolbars change without a parent React render.
// Observe their actual rectangles and coalesce native hit-test updates per frame.
export function observeInteractionRegions(root: HTMLElement, selector: string, update: (elements: Element[]) => void) {
  let frame = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false
  const measured = new Set<Element>()
  const flush = () => {
    cancelAnimationFrame(frame); clearTimeout(timer); frame = 0; timer = undefined
    if (!disposed) update([...root.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0))
  }
  const schedule = () => { if (!frame && !disposed) { frame = requestAnimationFrame(flush); timer = setTimeout(flush, 40) } }
  const resize = new ResizeObserver(schedule)
  const sync = () => {
    const next = new Set(root.querySelectorAll(selector))
    for (const element of measured) if (!next.has(element)) { resize.unobserve(element); measured.delete(element) }
    for (const element of next) if (!measured.has(element)) { measured.add(element); resize.observe(element) }
    schedule()
  }
  const mutation = new MutationObserver(sync)
  mutation.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-pixel-revision'] })
  resize.observe(root); sync(); window.addEventListener('resize', schedule)
  return () => { disposed = true; cancelAnimationFrame(frame); clearTimeout(timer); resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', schedule) }
}
