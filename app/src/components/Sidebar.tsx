import { useState } from 'react';
import { edit, select, useStore } from '../store.ts';
import { genId } from '../lib/labels.ts';
import { deviceColor, GROUP_COLORS } from '../lib/colors.ts';

export function Sidebar() {
  const [tab, setTab] = useState<'dev' | 'cmd' | 'trig'>('dev');
  const project = useStore((s) => s.project)!;
  const sel = useStore((s) => s.sel);

  const addDevice = () => {
    const id = genId('d');
    edit((p) => { p.devices.push({ id, name: '新设备', ip: '192.168.1.100', color: GROUP_COLORS[p.devices.length % GROUP_COLORS.length], format: 'ascii', terminator: 'none' }); });
    select({ kind: 'device', id });
  };
  const addCommand = () => {
    const id = genId('cmd');
    edit((p) => {
      const first = p.devices[0];
      (p.commands ??= []).push({
        id, name: '新指令', targets: first ? [first.id] : [], port: first?.port ?? 5000, format: 'ascii', payload: 'HELLO', params: [],
      });
    });
    select({ kind: 'command', id });
  };
  const addTrigger = () => {
    const id = genId('tr');
    edit((p) => {
      p.triggers.push({ id, name: '新触发器', port: 9000, allowFrom: ['192.168.1.0/24'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [] });
    });
    select({ kind: 'trigger', id });
  };

  return (
    <aside className="side">
      <div className="tabs">
        <span className={tab === 'dev' ? 'on' : ''} onClick={() => setTab('dev')}>设备 {project.devices.length}</span>
        <span className={tab === 'cmd' ? 'on' : ''} onClick={() => setTab('cmd')}>指令 {(project.commands ?? []).length}</span>
        <span className={tab === 'trig' ? 'on' : ''} onClick={() => setTab('trig')}>触发器 {project.triggers.length}</span>
      </div>
      <div className="sidebody">
        {tab === 'dev' ? (
          <>
            <div className="sechead">UDP 设备 <button onClick={addDevice}>＋</button></div>
            {project.devices.length === 0 && <div className="empty">还没有设备。点右上角＋添加接收端的 IP 和端口。</div>}
            {project.devices.map((d) => (
              <div key={d.id} className={`dev ${sel?.kind === 'device' && sel.id === d.id ? 'sel' : ''}`} onClick={() => select({ kind: 'device', id: d.id })}>
                <div className="n"><i style={{ background: deviceColor(project, d.id), opacity: d.enabled === false ? .4 : 1 }} />{d.name}{d.tag && <span className="tag r">{d.tag}</span>}</div>
                <div className="a mono"><span>{d.ip}{d.port ? `:${d.port}` : ''}</span><span className={`tag ${d.format === 'hex' ? 'hex' : 'asc'}`}>{(d.format ?? 'ascii').toUpperCase()}</span></div>
              </div>
            ))}
          </>
        ) : tab === 'cmd' ? (
          <>
            <div className="sechead">UDP 指令库 <button onClick={addCommand}>＋</button></div>
            {(project.commands ?? []).length === 0 && (
              <div className="empty">还没有指令。把常用的 UDP 内容（目标、端口、格式、参数）配成指令，时间线和触发器上直接选用，不用每次重填。</div>
            )}
            {(project.commands ?? []).map((c) => (
              <div key={c.id} className={`dev ${sel?.kind === 'command' && sel.id === c.id ? 'sel' : ''}`} onClick={() => select({ kind: 'command', id: c.id })}>
                <div className="n">{c.name}{(c.params ?? []).length > 0 && <span className="tag r">{(c.params ?? []).length} 参数</span>}</div>
                <div className="a mono"><span>{c.payload.length > 26 ? c.payload.slice(0, 26) + '…' : c.payload}</span><span className={`tag ${c.format === 'hex' ? 'hex' : 'asc'}`}>{c.format.toUpperCase()}</span></div>
                <div className="a"><span className="dim">{c.targets.map((t) => (t.startsWith('tag:') ? `标签 ${t.slice(4)}` : (project.devices.find((d) => d.id === t)?.name ?? '？'))).join('、') || '（无目标）'}{c.port ? ` :${c.port}` : ''}</span></div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="sechead">接收触发 <button onClick={addTrigger}>＋</button></div>
            {project.triggers.length === 0 && <div className="empty">还没有触发器。收到指定 UDP 内容时执行一组动作。</div>}
            {project.triggers.map((t) => (
              <div key={t.id} className={`dev ${sel?.kind === 'trigger' && sel.id === t.id ? 'sel' : ''}`} onClick={() => select({ kind: 'trigger', id: t.id })}>
                <div className="n">{t.name}<span className="tag r">:{t.port}</span></div>
                <div className="a mono"><span>{t.match.kind} {t.match.pattern}</span></div>
                <div className="a"><span className={t.allowFrom.includes('*') ? 'warnc' : 'dim'}>来源 {t.allowFrom.includes('*') ? '任意 ⚠' : t.allowFrom.join(', ') || '无（全部拒绝）'}</span></div>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
