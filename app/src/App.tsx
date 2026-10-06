import { useEffect, useRef } from 'react';
import { discardDraft, handleEditShortcut, init, lockNow, openSettings, openUnlock, reloadFromEngine, restoreDraft, setView, useStore } from './store.ts';
import { TopBar } from './components/TopBar.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Timeline } from './components/Timeline.tsx';
import { Inspector } from './components/Inspector.tsx';
import { LogPanel } from './components/LogPanel.tsx';
import { CalendarView } from './components/Calendar.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { BackupDialog, UnlockDialog } from './components/LockDialogs.tsx';
import { shouldAutoLock } from './lib/lockUi.ts';
import { appBridge } from './transport.ts';
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
  const lock = useStore((s) => s.lock);
  const unlockOpen = useStore((s) => s.unlockOpen);
  const backupOpen = useStore((s) => s.backupOpen);
  const draftOffer = useStore((s) => s.draftOffer);
  const logCollapsed = useStore((s) => s.logCollapsed);

  useEffect(() => {
    void init();
    const off = appBridge?.onNeedUnlock(openUnlock); // 主进程发现被锁住时，请界面弹出解锁框
    document.addEventListener('keydown', handleEditShortcut);
    return () => {
      document.removeEventListener('keydown', handleEditShortcut);
      off?.();
    };
  }, []);

  // 界面闲置超过 10 分钟，自动重新上锁（只对「设了密码且已解锁」生效）。注意：hooks 必须放在下面的 early return 之前
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    const bump = () => { lastActivity.current = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(() => {
      if (shouldAutoLock(lock, lastActivity.current, Date.now())) void lockNow();
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(timer);
    };
  }, [lock]);

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
      {lock.enabled && !lock.unlocked && (
        <div className="banner warn">
          🔒 编辑已锁定，当前只读：可以查看日程、日志，也可以急停；修改配置需要先解锁。
          <button onClick={openUnlock}>解锁</button>
        </div>
      )}
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
      {unlockOpen && <UnlockDialog />}
      {backupOpen && <BackupDialog />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
