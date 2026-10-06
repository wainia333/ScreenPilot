import { Component, type ReactNode } from 'react'
import { captureBridge } from './bridge'
import { CaptureNotice } from './notice'
export class CaptureRenderBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { void captureBridge.action(this.props.id, 'load_failed').catch(() => { /* Keep the explicit exit action if native cleanup failed. */ }) }
  render() {
    if (this.state.failed) return <div className="jt-surface"><CaptureNotice message="截图界面加载失败。" tone="error"><button type="button" onClick={() => void captureBridge.action(this.props.id, 'cancel')}>退出截图</button></CaptureNotice></div>
    return this.props.children
  }
}
