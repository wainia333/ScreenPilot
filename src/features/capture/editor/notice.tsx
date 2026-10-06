import type { ComponentProps } from 'react'
import { TopNotice } from '../../../shared/ui/top-notice'
import { screenFor, type CaptureSnapshot } from './model'

export function CaptureNotice({ snapshot, ...props }: ComponentProps<typeof TopNotice> & { snapshot?: CaptureSnapshot }) {
  const monitor = snapshot && screenFor(snapshot.selection ?? snapshot.bounds, snapshot.screens)
  const ratio = snapshot ? window.innerWidth / snapshot.bounds.width : 1
  const style = snapshot && snapshot.mode !== 'pin' && monitor ? { left: (monitor.x - snapshot.bounds.x + monitor.width / 2) * ratio, top: Math.max(0, monitor.y - snapshot.bounds.y) * ratio + 18 } : undefined
  return <TopNotice {...props} style={style} portal />
}
