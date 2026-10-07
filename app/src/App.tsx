import { useEffect, useRef } from 'react';
import { cancelDeferredApply, closeResumeSummary, showLogTab, discardDraft, handleEditShortcut, init, keepDraftOverEngine, lockNow, openSettings, openUnlock, reloadFromEngine, restoreDraft, setView, toast, useStore } from './store.ts';
import { ApplyDialog } from './components/ApplyDialog.tsx';
import { Overview } from './components/Overview.tsx';
import { RuntimeConfiguration } from './components/RuntimeConfiguration.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Timeline } from './components/Timeline.tsx';
import { Inspector } from './components/Inspector.tsx';
import { LogPanel } from './components/LogPanel.tsx';
import { CalendarView } from './components/Calendar.tsx';
import { PadView } from './components/PadView.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { BackupDialog, UnlockDialog } from './components/LockDialogs.tsx';
import { BatchHealthDialog } from './components/BatchHealthDialog.tsx';
import { shouldAutoLock } from './lib/lockUi.ts';
import { appBridge } from './transport.ts';
import { EngineVersionBanner } from './components/EngineVersion.tsx';
import { Splitter } from './components/Splitter.tsx';
import { Icon } from './components/Icon.tsx';
import { layoutVars, resetLayout, useLayout } from './lib/layoutStore.ts';
import { autoZoomController } from './lib/autoZoomRuntime.ts';

const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

export function App() {
  const loaded = useStore((s) => s.loaded);
  const conn = useStore((s) => s.conn);
  const toastMsg = useStore((s) => s.toast);
  const saveState = useStore((s) => s.saveState);
  const startError = useStore((s) => s.status?.daemon.startError);
  const view = useStore((s) => s.view);
  const configurationView = useStore((s) => s.configurationView);
  const deferredApply = useStore((s) => s.deferredApply);
  const resumeSummary = useStore((s) => s.resumeSummary);
  const notice = useStore((s) => s.status?.daemon.notice);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const lock = useStore((s) => s.lock);
  const unlockOpen = useStore((s) => s.unlockOpen);
  const backupOpen = useStore((s) => s.backupOpen);
  const batchHealthOpen = useStore((s) => s.batchHealthOpen);
  const draftOffer = useStore((s) => s.draftOffer);
  const logCollapsed = useStore((s) => s.logCollapsed);
  const layout = useLayout();

  useEffect(() => {
    void init();
    const off = appBridge?.onNeedUnlock(openUnlock); // 主进程发现被锁住时，请界面弹出解锁框
    const offLayout = appBridge?.onResetLayout(() => { resetLayout(); toast('界面布局已恢复默认'); }); // 菜单「视图 → 恢复默认界面布局」
    const offAuto = appBridge?.onAutoZoom(() => { autoZoomController()?.set(true); toast('已开启：界面随窗口大小自动缩放'); });
    const zoom = autoZoomController();
    let zoomTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => { clearTimeout(zoomTimer); zoomTimer = setTimeout(() => zoom?.apply(), 120); };
    zoom?.apply();
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', handleEditShortcut);
    return () => {
      document.removeEventListener('keydown', handleEditShortcut);
      off?.();
      offLayout?.();
      offAuto?.();
      window.removeEventListener('resize', onResize);
      clearTimeout(zoomTimer);
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
          🔒 编辑已锁定，当前只读：可以查看日程、日志，也可以暂停自动日程、操作面板和接管设备；修改配置需要先解锁。
          <button onClick={openUnlock}>解锁</button>
        </div>
      )}
      {conn === 'disconnected' && <div className="banner bad">与引擎的连接已断开，正在自动重连。引擎在后台独立运行，日程不受影响。</div>}
      {saveState === 'conflict' && (
        <div className="banner warn">
          引擎配置已在别处改变（另一个窗口应用、从备份恢复或打开了其他配置），和你的本机草稿冲突。草稿仍保存在本机。
          <button onClick={() => void keepDraftOverEngine()}>以我的草稿为准（先看差异）</button>
          <button onClick={() => void reloadFromEngine()}>放弃本地修改并重新加载</button>
        </div>
      )}
      {resumeSummary && (
        <div className="banner warn resume-summary">
          <span>已恢复自动日程。暂停期间{resumeSummary.since ? `（${clock(resumeSummary.since)}–${clock(resumeSummary.until)}）` : ''}
            {resumeSummary.skippedTotal > 0 && <>跳过了 {resumeSummary.skippedTotal} 个动作，<b>不会补发</b>：{resumeSummary.skipped.slice(0, 6).map((x) => `${x.source}${x.count > 1 ? ` ×${x.count}` : ''}`).join('、')}{resumeSummary.skipped.length > 6 ? ` 等 ${resumeSummary.skipped.length} 处` : ''}。</>}
            {resumeSummary.ignoredPackets > 0 && <>收到 {resumeSummary.ignoredPackets} 个 UDP 触发包未处理。</>}
            需要的话可以在左侧「指令」或面板里手动补发。</span>
          <button onClick={() => showLogTab('log')}>查看日志</button>
          <button onClick={closeResumeSummary}>知道了</button>
        </div>
      )}
      {deferredApply && (
        <div className="banner warn">
          新配置已通过检查，交给引擎挂起：正在执行的动作链结束后自动应用{deferredApply.deadline ? `（最晚等到 ${new Date(deferredApply.deadline).toLocaleTimeString('zh-CN', { hour12: false })}）` : ''}。在此之前运行的仍是旧配置。
          <button onClick={() => void cancelDeferredApply()}>取消延后应用</button>
        </div>
      )}
      {draftOffer && (
        <div className="banner warn">
          发现尚未应用的本机草稿（{new Date(draftOffer.at).toLocaleString()}，尚未交给引擎）。
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
      <div className={`body ${logCollapsed ? 'log-collapsed' : ''}`} style={layoutVars(layout)}>
        <Sidebar />
        <div className={`center ${configurationView === 'draft' ? 'draft-mode' : ''}`}>
          <div className="viewtabs">
            <span className={view === 'overview' ? 'on' : ''} title="运行总览" onClick={() => setView('overview')}><Icon name="activity" size={15} /><em>运行总览</em></span>
            <span className={view === 'timeline' ? 'on' : ''} title="模式与时间轴" onClick={() => setView('timeline')}><Icon name="timeline" size={15} /><em>模式与时间轴</em></span>
            <span className={view === 'calendar' ? 'on' : ''} title="日历与预览" onClick={() => setView('calendar')}><Icon name="calendar" size={15} /><em>日历与预览</em></span>
            <span className={view === 'pad' ? 'on' : ''} title="操作面板" onClick={() => setView('pad')}><Icon name="pad" size={15} /><em>操作面板</em></span>
            <b className="grow" />
            <RuntimeConfiguration />
          </div>
          {view === 'overview' ? <Overview /> : view === 'timeline' ? <Timeline /> : view === 'calendar' ? <CalendarView /> : <PadView />}
        </div>
        <Inspector />
        <LogPanel />
        <Splitter k="sideW" orientation="vertical" className="side-split" label="左侧栏宽度" step={1} measure={(e, r) => e.clientX - r.left} />
        <Splitter k="inspW" orientation="vertical" className="insp-split" label="检查器宽度" step={-1} measure={(e, r) => r.right - e.clientX} />
        {!logCollapsed && <Splitter k="logH" orientation="horizontal" className="log-split" label="日志高度" step={-1} measure={(e, r) => r.bottom - e.clientY} />}
      </div>
      <ApplyDialog />
      {settingsOpen && <SettingsDialog />}
      {unlockOpen && <UnlockDialog />}
      {backupOpen && <BackupDialog />}
      {batchHealthOpen && <BatchHealthDialog />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
