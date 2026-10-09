import { useEffect, useMemo, useState } from 'react';
import { displayedProject, finishEditing, viewingRuntime, edit, engineNow, keepDraftOverEngine, resumeSchedule, lockNow, openUnlock, prepareApply, reloadFromEngine, rpc, showLogTab, toast, useStore } from '../store.ts';
import { mergeAlerts, unseenCount } from '../lib/alerts.ts';
import { ProjectMenu } from './ProjectMenu.tsx';
import { Icon } from './Icon.tsx';
import { ModeControl } from './RuntimeConfiguration.tsx';


const p2 = (n: number) => String(n).padStart(2, '0');

function Clock() {
  const [now, setNow] = useState(engineNow());
  useEffect(() => {
    const t = setInterval(() => setNow(engineNow()), 200);
    return () => clearInterval(t);
  }, []);
  const d = new Date(now);
  const engine = useStore((s) => s.status?.engine ?? null);
  const next = engine?.upcoming[0];
  const left = next ? Math.max(0, next.epoch - now) : 0;
  const ls = Math.floor(left / 1000);
  return (
    <>
      <div className="clock">
        <div className="t">{p2(d.getHours())}:{p2(d.getMinutes())}:{p2(d.getSeconds())}</div>
        <div className="d">
          {d.getFullYear()}-{p2(d.getMonth() + 1)}-{p2(d.getDate())} 星期{'日一二三四五六'[d.getDay()]}
          {engine && <> · {engine.dayKind}{engine.holidayName ? `（${engine.holidayName}）` : ''}</>}
        </div>
      </div>
      <div className="next">
        <div className="l">下一事件点</div>
        <div className="v">
          {next ? (
            <>
              {next.date !== engine!.date && <span className="dim">{next.date.slice(5)} </span>}
              {next.time.slice(0, 8)} {next.timelineName}·{next.cueName} <em>-{p2(Math.floor(ls / 3600))}:{p2(Math.floor((ls % 3600) / 60))}:{p2(ls % 60)}</em>
            </>
          ) : (
            <span className="dim">近 8 天内没有事件点</span>
          )}
        </div>
      </div>
    </>
  );
}

export function TopBar() {
  const project = useStore(displayedProject)!;
  const readonly = useStore(viewingRuntime);
  const conn = useStore((s) => s.conn);
  const status = useStore((s) => s.status);
  const saveState = useStore((s) => s.saveState);
  const deferred = useStore((s) => !!s.deferredApply);
  const lock = useStore((s) => s.lock);
  const logs = useStore((s) => s.logs);
  const history = useStore((s) => s.alertHistory);
  const seenAt = useStore((s) => s.alertsSeenAt);
  const alerts = useMemo(() => unseenCount(mergeAlerts(history, logs), seenAt), [history, logs, seenAt]);
  const engine = status?.engine ?? null;
  const paused = engine?.paused === true;

  const togglePause = async () => {
    try {
      if (paused) await resumeSchedule();
      else await rpc('pause');
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`);
    }
  };

  const engineText =
    conn !== 'connected' ? '与引擎断开，重连中…' : !engine ? '引擎未运行' : engine.dryRun ? '引擎（模拟模式，不发包）' : '引擎运行中';
  const tone = conn !== 'connected' || !engine ? 'bad' : paused ? 'warn' : 'ok';

  return (
    <header className="top">
      <div className="logo"><span className="logo-mark" aria-hidden="true" /><span>Cue<b>Clock</b></span></div>
      <ProjectMenu file={status?.daemon.projectFile ?? null} />
      <input className="projname" readOnly={readonly} aria-label={readonly ? "运行配置名称（只读）" : "草稿配置名称"} value={project.name} onChange={(e) => edit((p) => (p.name = e.target.value))} title={status?.daemon.projectFile} />
      <ModeControl />
      {saveState !== 'saved' && saveState !== 'conflict' && !deferred && <button className="primary apply-open" disabled={saveState === 'saving' || conn !== 'connected'} onClick={() => void prepareApply()}>检查并应用</button>}
      {saveState === 'conflict' && <button className="primary apply-open" disabled={conn !== 'connected'} title="以本机草稿为准：先列出相对引擎当前配置的全部差异（含别处的修改会被覆盖的部分），确认后才应用" onClick={() => void keepDraftOverEngine()}>以我的草稿为准…</button>}
      {saveState === 'conflict' && <button onClick={() => void reloadFromEngine()}>放弃本地修改并重新加载</button>}
      {saveState === 'saved' && !readonly && !deferred && <button className="apply-open" title="草稿与运行配置一致，没有要应用的改动；回到「运行」" onClick={finishEditing}>完成编辑</button>}
      <span className="grow" />
      <Clock />
      <button className={`estop ${paused ? 'on' : ''}`} disabled={!engine} onClick={togglePause} title="暂停期间到点的事件和 UDP 触发都不执行；面板、手动操作与在线检测仍可用。恢复时不补发错过的事件。">
        {paused ? <><Icon name="play" size={14} />自动已暂停 · 恢复</> : <><Icon name="pause" size={14} />暂停自动日程</>}
      </button>
      {alerts.count > 0 && (
        <button className={`alertpill ${alerts.hasError ? 'bad' : 'warn'}`} onClick={() => showLogTab('alerts')} title="有新的告警，点击查看（只记录在日志里，不对外发送）">
          <Icon name="alert" size={14} />{alerts.count} 条新告警
        </button>
      )}
      {lock.enabled && (lock.unlocked
        ? <button onClick={() => void lockNow()} title="立即锁定编辑（查看和急停不受影响）"><Icon name="unlock" size={14} />锁定</button>
        : <button className="lockpill" onClick={openUnlock} title="编辑已锁定，点击输入密码解锁"><Icon name="lock" size={14} />已锁定 · 解锁</button>)}
      <div className="nic">
        <span className="nic-l1"><span className={`dot ${tone}`} />{engineText}</span>
        <span className="nic-l2">{engine
          ? `网卡 ${engine.network.localAddresses?.join('、') || '自动'}${engine.network.missing.length ? `（缺 ${engine.network.missing.length}）` : ''} · ${engine.listeners.length > 0 ? `监听 UDP ${engine.listeners.join(' / ')}` : '未监听触发端口'}`
          : status?.network?.settings.localAddresses?.length ? `网卡 ${status.network.settings.localAddresses.join('、')}` : ''}</span>
      </div>
    </header>
  );
}
