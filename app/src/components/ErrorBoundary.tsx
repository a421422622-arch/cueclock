import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { protectDraft } from '../store.ts';
import { RestartEngineButton } from './EngineVersion.tsx';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    protectDraft();
    console.error(`界面渲染失败：${error.message}`, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="splash render-error" role="alert">
      <div className="logo big">Cue<b>Clock</b></div>
      <h2>界面显示遇到问题</h2>
      <p>界面与引擎独立运行。重新加载界面不会清空已保存的项目，未保存的编辑会保留为草稿。</p>
      <button className="primary" onClick={() => window.location.reload()}>重新加载界面</button>
      <RestartEngineButton />
    </div>;
  }
}
