import { useState } from 'react';
import type { Command } from '@engine/types.ts';
import { displayedProject, viewingRuntime, beginDraft, edit, openBatchHealth, rpc, select, toast, useStore } from '../store.ts';
import { RpcFailure } from '../transport.ts';
import { describeStatus, requiredParams, summarize } from '../lib/commandTest.ts';
import type { TestOutcome } from '../lib/commandTest.ts';
import { genId } from '../lib/labels.ts';
import { sceneRefCount } from '../lib/usage.ts';
import { describeDeviceState } from '../lib/deviceState.ts';
import { engineNow } from '../store.ts';
import { Icon } from './Icon.tsx';
import { deviceColor, GROUP_COLORS } from '../lib/colors.ts';
import { DEVICE_TEMPLATES, fromTemplate, newCommandFor } from '../lib/deviceTemplates.ts';
import type { DeviceTemplate } from '../lib/deviceTemplates.ts';

/** 列表里的快速测试：有必填参数就转到右侧填写；否则直接发，结果用提示条说明。 */
async function quickTest(c: Command): Promise<void> {
  select({ kind: 'command', id: c.id });
  if (requiredParams(c).length > 0) { toast(`「${c.name}」有必填参数，请在右侧填写后点「测试发送」`); return; }
  try {
    const o = await rpc<TestOutcome>('runCommand', { command: c, wait: true });
    const s = summarize(o);
    toast(`测试「${c.name}」：${s.text}${o.results.length === 1 ? `（${describeStatus(o.results[0]!.status).text}）` : ''}`);
  } catch (e) {
    toast(`测试「${c.name}」失败：${e instanceof RpcFailure ? e.message : String(e)}`);
  }
}

export function Sidebar() {
  const [tab, setTab] = useState<'dev' | 'cmd' | 'scene' | 'trig'>('dev');
  const project = useStore(displayedProject)!;
  const readonly = useStore(viewingRuntime);
  const sel = useStore((s) => s.sel);
  const health = useStore((s) => s.status?.engine?.devices);

  const [templatesOpen, setTemplatesOpen] = useState(false);
  const addDevice = (tpl: DeviceTemplate) => {
    setTemplatesOpen(false);
    if (!beginDraft()) return;
    const made = fromTemplate(tpl, { device: genId('d'), command: () => genId('cmd') }, GROUP_COLORS[project.devices.length % GROUP_COLORS.length]!);
    edit((p) => { p.devices.push(made.device); if (made.commands.length) (p.commands ??= []).push(...made.commands); });
    select({ kind: 'device', id: made.device.id });
    if (made.commands.length) toast(`已建好设备和 ${made.commands.length} 条指令（${made.commands.map((c) => c.name.split(' · ').pop()).join('、')}），在「指令」页签里`);
  };
  const addCommand = () => {
    if (!beginDraft()) return;
    const id = genId('cmd');
    const selected = sel?.kind === 'device' ? project.devices.find((d) => d.id === sel.id) : undefined;
    edit((p) => { (p.commands ??= []).push(newCommandFor(selected ?? p.devices[0], id)); });
    select({ kind: 'command', id });
  };
  const addScene = () => {
    if (!beginDraft()) return;
    const id = genId('scene');
    edit((p) => {
      (p.scenes ??= []).push({ id, name: '新场景', actions: [] });
    });
    select({ kind: 'scene', id });
  };
  const addTrigger = () => {
    if (!beginDraft()) return;
    const id = genId('tr');
    edit((p) => {
      p.triggers.push({ id, name: '新触发器', port: 9000, allowFrom: ['192.168.1.0/24'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [] });
    });
    select({ kind: 'trigger', id });
  };

  return (
    <aside className="side">
      <div className="tabs">
        <span className={tab === 'dev' ? 'on' : ''} onClick={() => setTab('dev')} title="设备"><Icon name="device" size={15} /><em>设备</em><i className="cnt">{project.devices.length}</i></span>
        <span className={tab === 'cmd' ? 'on' : ''} onClick={() => setTab('cmd')} title="指令"><Icon name="terminal" size={15} /><em>指令</em><i className="cnt">{(project.commands ?? []).length}</i></span>
        <span className={tab === 'scene' ? 'on' : ''} onClick={() => setTab('scene')} title="场景"><Icon name="layers" size={15} /><em>场景</em><i className="cnt">{(project.scenes ?? []).length}</i></span>
        <span className={tab === 'trig' ? 'on' : ''} onClick={() => setTab('trig')} title="触发器"><Icon name="zap" size={15} /><em>触发器</em><i className="cnt">{project.triggers.length}</i></span>
      </div>
      <div className="sidebody">
        {tab === 'dev' ? (
          <>
            <div className="sechead">UDP 设备 <span><button title="批量设置在线检测（Ping / UDP 探测、间隔）" onClick={() => openBatchHealth()} disabled={readonly || project.devices.length === 0}>批量检测…</button> <span className="addmenu"><button className="ico add" title="新建设备（选模板）" aria-expanded={templatesOpen} onClick={() => setTemplatesOpen(!templatesOpen)}><Icon name="plus" size={14} /></button>
              {templatesOpen && <div className="addmenu-pop" role="menu" onMouseLeave={() => setTemplatesOpen(false)}>
                {DEVICE_TEMPLATES.map((t) => <button key={t.id} role="menuitem" onClick={() => addDevice(t)}><b>{t.label}</b><small>{t.note}</small></button>)}
              </div>}</span></span></div>
            {project.devices.length === 0 && <div className="empty">还没有设备。点右上角＋添加接收端的 IP 和端口。</div>}
            {project.devices.map((d) => {
              // 名字前的圆点 = 在线状态（绿在线 / 黄异常 / 红离线 / 灰未检测或已禁用）；轨道颜色是名字后面的小色块
              const st = describeDeviceState(health?.find((x) => x.id === d.id), d.enabled !== false, engineNow());
              const waiting = !!d.health && d.enabled !== false && st.light === 'unknown';
              return <div key={d.id} className={`dev ${sel?.kind === 'device' && sel.id === d.id ? 'sel' : ''}`} onClick={() => select({ kind: 'device', id: d.id })}>
                <div className="n"><i className={`statusdot ${st.light}`} title={waiting ? '已设置在线检测，等待第一次检测结果' : st.light === 'unknown' ? '未设置在线检测，状态未知' : st.title} />{d.name}{d.tag && <span className="tag r">{d.tag}</span>}
                  <b className="swatch" title="这台设备在时间轴上的轨道颜色" style={{ background: deviceColor(project, d.id), opacity: d.enabled === false ? .4 : 1 }} /></div>
                <div className="a mono"><span>{d.ip}{d.port ? `:${d.port}` : ''}</span><span className={`tag ${d.format === 'hex' ? 'hex' : 'asc'}`}>{(d.format ?? 'ascii').toUpperCase()}</span></div>
                {waiting ? <div className="a"><span className="light unknown">等待首次检测…</span></div>
                  : st.light === 'unknown' || st.light === 'disabled' ? null : <div className="a"><span className={`light ${st.light}`} title={st.title}>{st.label}</span></div>}
              </div>;
            })}
          </>
        ) : tab === 'cmd' ? (
          <>
            <div className="sechead">UDP 指令库 <button className="ico add" title="新建指令" onClick={addCommand}><Icon name="plus" size={14} /></button></div>
            {(project.commands ?? []).length === 0 && (
              <div className="empty">还没有指令。把常用的 UDP 内容（目标、端口、格式、参数）配成指令，时间线和触发器上直接选用，不用每次重填。</div>
            )}
            {(project.commands ?? []).map((c) => (
              <div key={c.id} className={`dev ${sel?.kind === 'command' && sel.id === c.id ? 'sel' : ''}`} onClick={() => select({ kind: 'command', id: c.id })}>
                <div className="n">{c.name}{(c.params ?? []).length > 0 && <span className="tag r">{(c.params ?? []).length} 参数</span>}
                  <button className="ico rowtest" disabled={readonly} title="立即发送一次这条指令（真的会发出）" onClick={(e) => { e.stopPropagation(); void quickTest(c); }}><Icon name="play" size={11} />测试</button></div>
                <div className="a mono"><span>{c.payload.length > 26 ? c.payload.slice(0, 26) + '…' : c.payload}</span><span>{c.protocol && <span className="tag r">{c.protocol === 'pjlink' ? 'PJLink' : 'TCP'}</span>}<span className={`tag ${c.format === 'hex' ? 'hex' : 'asc'}`}>{c.format.toUpperCase()}</span></span></div>
                <div className="a"><span className="dim">{c.targets.map((t) => (t.startsWith('tag:') ? `标签 ${t.slice(4)}` : (project.devices.find((d) => d.id === t)?.name ?? '？'))).join('、') || '（无目标）'}{c.port ? ` :${c.port}` : ''}</span></div>
              </div>
            ))}
          </>
        ) : tab === 'scene' ? (
          <>
            <div className="sechead">场景库 <button className="ico add" title="新建场景" onClick={addScene}><Icon name="plus" size={14} /></button></div>
            {(project.scenes ?? []).length === 0 && (
              <div className="empty">还没有场景。把"开馆""闭馆"这类要同时做几件事的动作配成场景，时间线和触发器上整体选用，改一次处处生效。</div>
            )}
            {(project.scenes ?? []).map((sc) => (
              <div key={sc.id} className={`dev ${sel?.kind === 'scene' && sel.id === sc.id ? 'sel' : ''}`} onClick={() => select({ kind: 'scene', id: sc.id })}>
                <div className="n">{sc.name}<span className="tag r">{sc.actions.length} 个动作</span></div>
                {sc.note && <div className="a"><span className="dim">{sc.note}</span></div>}
                <div className="a"><span className="dim">被使用 {sceneRefCount(project, sc.id)} 次</span></div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="sechead">接收触发 <button className="ico add" title="新建触发器" onClick={addTrigger}><Icon name="plus" size={14} /></button></div>
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
