import { useEffect, useState } from 'react';
import { edit, engineNow, openSettings, reloadFromEngine, rpc, toast, useStore } from '../store.ts';
import type { SaveState } from '../store.ts';
import { ProjectMenu } from './ProjectMenu.tsx';

const SAVE_TEXT: Record<SaveState, string> = {
  saved: '已保存',
  dirty: '有未保存的修改…',
  saving: '保存中…',
  error: '未保存：项目有错误',
  conflict: '冲突：项目已被其他客户端修改',
};

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
  const project = useStore((s) => s.project)!;
  const conn = useStore((s) => s.conn);
  const status = useStore((s) => s.status);
  const saveState = useStore((s) => s.saveState);
  const engine = status?.engine ?? null;
  const paused = engine?.paused === true;

  const togglePause = async () => {
    try {
      await rpc(paused ? 'resume' : 'pause');
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`);
    }
  };

  const engineText =
    conn !== 'connected' ? '与引擎断开，重连中…' : !engine ? '引擎未运行' : engine.dryRun ? '引擎（模拟模式，不发包）' : '引擎运行中';
  const tone = conn !== 'connected' || !engine ? 'bad' : paused ? 'warn' : 'ok';

  return (
    <header className="top">
      <div className="logo">Cue<b>Clock</b></div>
      <ProjectMenu file={status?.daemon.projectFile ?? null} />
      <input className="projname" value={project.name} onChange={(e) => edit((p) => (p.name = e.target.value))} title={status?.daemon.projectFile} />
      <span className={`savestate ${saveState}`}>{SAVE_TEXT[saveState]}</span>
      {saveState === 'conflict' && <button onClick={() => void reloadFromEngine()}>放弃本地修改并重新加载</button>}
      <span className="grow" />
      <Clock />
      <button className={`estop ${paused ? 'on' : ''}`} disabled={!engine} onClick={togglePause} title="暂停期间到点的事件和 UDP 触发都不执行（手动测试不受影响）">
        {paused ? '▶ 已急停 · 点击恢复' : '■ 急停调度'}
      </button>
      <button onClick={openSettings} title="本机网卡、开机自启等设置">⚙ 设置</button>
      <div className="nic">
        <span className={`dot ${tone}`} />{engineText}
        <br />
        {engine
          ? `网卡 ${engine.network.localAddresses?.join('、') || '自动'}${engine.network.missing.length ? `（缺 ${engine.network.missing.length}）` : ''} · ${engine.listeners.length > 0 ? `监听 UDP ${engine.listeners.join(' / ')}` : '未监听触发端口'}`
          : status?.network?.settings.localAddresses?.length ? `网卡 ${status.network.settings.localAddresses.join('、')}` : ''}
      </div>
    </header>
  );
}
