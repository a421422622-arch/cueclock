import { useEffect } from 'react';
import { discardDraft, handleEditShortcut, init, openSettings, reloadFromEngine, restoreDraft, setView, useStore } from './store.ts';
import { TopBar } from './components/TopBar.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Timeline } from './components/Timeline.tsx';
import { Inspector } from './components/Inspector.tsx';
import { LogPanel } from './components/LogPanel.tsx';
import { CalendarView } from './components/Calendar.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { EngineVersionBanner } from './components/EngineVersion.tsx';

export function App() {
  const loaded = useStore((s) => s.loaded);
  const conn = useStore((s) => s.conn);
  const toastMsg = useStore((s) => s.toast);
  const saveState = useStore((s) => s.saveState);
  const startError = useStore((s) => s.status?.daemon.startError);
  const view = useStore((s) => s.view);
  const notice = useStore((s) => s.status?.daemon.notice);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const draftOffer = useStore((s) => s.draftOffer);
  const logCollapsed = useStore((s) => s.logCollapsed);

  useEffect(() => {
    void init();
    document.addEventListener('keydown', handleEditShortcut);
    return () => document.removeEventListener('keydown', handleEditShortcut);
  }, []);

  if (!loaded) {
    return (
      <div className="splash">
        <div className="logo big">Cue<b>Clock</b></div>
        <div className="dim">{conn === 'disconnected' ? '正在连接引擎…（引擎未运行或尚未启动）' : '加载中…'}</div>
      </div>
    );
  }
  return (
    <div className="app">
      <TopBar />
      <EngineVersionBanner />
      {conn === 'disconnected' && <div className="banner bad">与引擎的连接已断开，正在自动重连。引擎在后台独立运行，日程不受影响。</div>}
      {saveState === 'conflict' && (
        <div className="banner warn">
          项目已被其他客户端修改，你的本地修改暂未保存。<button onClick={() => void reloadFromEngine()}>放弃本地修改并重新加载</button>
        </div>
      )}
      {draftOffer && (
        <div className="banner warn">
          发现上次没能保存的草稿（{new Date(draftOffer.at).toLocaleString()}，当时项目有错误，所以没有交给引擎）。
          <button onClick={restoreDraft}>恢复草稿</button>
          <button onClick={discardDraft}>丢弃</button>
        </div>
      )}
      {notice && <div className="banner warn">{notice}</div>}
      {startError && (
        <div className="banner bad">
          引擎未运行：{startError}
          {/项目检查/.test(startError) ? '　请在「问题」里修正，保存成功后引擎会自动启动。' : ''}
          <button onClick={openSettings}>打开设置</button>
        </div>
      )}
      <div className={`body ${logCollapsed ? 'log-collapsed' : ''}`}>
        <Sidebar />
        <div className="center">
          <div className="viewtabs">
            <span className={view === 'timeline' ? 'on' : ''} onClick={() => setView('timeline')}>模式与时间轴</span>
            <span className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')}>日历与预览</span>
          </div>
          {view === 'timeline' ? <Timeline /> : <CalendarView />}
        </div>
        <Inspector />
        <LogPanel />
      </div>
      {settingsOpen && <SettingsDialog />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
