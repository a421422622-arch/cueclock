import { useEffect, useState } from 'react';
import { engineNow, rpc, select, setView, showLogTab, toast, useStore } from '../store.ts';
import { commandLabel, feedbackLabel, runningModes } from '../lib/operations.ts';
import { describeDeviceState } from '../lib/deviceState.ts';
import { Icon } from './Icon.tsx';

const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
const RUN: Record<string, string> = { running: '执行中', completed: '动作处理完成', failed: '有失败步骤', cancelled: '已停止后续', incomplete: '有未观察步骤' };
const STEP: Record<string, string> = { pending: '待执行', waiting: '等待中', running: '发送 / 等回包', confirmed: '回包确认', sent: '已发出（未确认）', timeout: '回包超时', mismatch: '回包不符', error: '失败', skipped: '跳过', cancelled: '停止', done: '延时完成', 'not-observed': '启动前未观察' };

export function Overview() {
  const project = useStore((s) => s.runningProject ?? s.project)!;
  const status = useStore((s) => s.status);
  const conn = useStore((s) => s.conn);
  const modeId = useStore((s) => s.modeId);
  const logs = useStore((s) => s.logs);
  const engine = status?.engine;
  const [now, setNow] = useState(engineNow());
  const [duration, setDuration] = useState(15 * 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(engineNow()), 1000); return () => clearInterval(t); }, []);
  const modes = runningModes(engine?.timelines ?? []);
  const viewed = project.timelines.find((t) => t.id === modeId)?.name;
  const next = engine?.upcoming[0];
  const bad = engine?.devices.filter((d) => d.state === 'offline' || d.state === 'failing').length ?? 0;
  const failures = logs.filter((l) => l.alert && (l.alert.level === 'error' || l.alert.level === 'warn')).slice(-5).reverse();
  const takeover = async (id: string, release: boolean) => {
    setBusy(id);
    try { await rpc('setDeviceOverride', { deviceId: id, durationMs: release ? null : duration }); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  };
  return <div className="overview">
    <div className="overview-heading"><div><h2>运行总览</h2><p>运行状态来自引擎；设备状态注明检测方式与更新时间。</p></div><button onClick={() => setView('pad')}><Icon name="pad" size={14} />打开操作面板</button></div>
    <div className="overview-cards">
      <article data-tone={conn !== 'connected' || !engine?.running ? 'bad' : engine.paused ? 'warn' : 'ok'}><header><Icon name="activity" size={15} /><small>自动运行</small></header><strong>{conn !== 'connected' ? '连接中断 · 状态待核实' : !engine?.running ? '引擎未运行' : engine.dryRun ? '模拟模式' : engine.paused ? '已暂停' : '运行中'}</strong><p>暂停自动日程与 UDP 触发，手动操作和在线检测仍可用。</p></article>
      <article data-tone="info"><header><Icon name="calendar" size={15} /><small>今日生效模式</small></header><strong>{modes.join('、') || '无'}</strong><p>{engine?.date} · {engine?.dayKind}{viewed ? `；时间轴查看：${viewed}` : ''}</p></article>
      <article data-tone="info"><header><Icon name="clock" size={15} /><small>下一事件</small></header><strong>{next ? `${next.time} · ${next.cueName}` : '近 8 天没有事件'}</strong><p>{next ? `${next.timelineName} · ${next.date} · ${Math.max(0, Math.ceil((next.epoch - now) / 1000))} 秒后${engine?.paused ? '（暂停中，将跳过）' : ''}` : '可前往模式与时间轴安排日程'}</p></article>
      <article data-tone={bad ? 'bad' : 'neutral'}><header><Icon name="device" size={15} /><small>设备检测</small></header><strong>{bad ? `${bad} 台异常` : '暂无已检测异常'}</strong><p>{project.devices.filter((d) => d.enabled !== false).length} 台启用设备；未检测不代表在线。</p></article>
    </div>
    <div className="overview-heading"><h3>设备与手动接管</h3><label>接管期限 <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}><option value={300000}>5 分钟</option><option value={900000}>15 分钟</option><option value={3600000}>1 小时</option></select></label></div>
    <p className="hint">接管期间该设备的自动日程、UDP 触发和恢复动作跳过；到期恢复后续动作。面板亮灭表示操作记录。</p>
    <div className="overview-table"><table><thead><tr><th>设备</th><th>网络 / 回包检测</th><th>最后控制操作</th><th>设备状态回读</th><th>控制归属</th></tr></thead><tbody>
      {project.devices.map((d) => {
        const info = engine?.devices.find((x) => x.id === d.id);
        const light = describeDeviceState(info, d.enabled !== false, now);
        const f = info?.feedback;
        const feedback = f && { ...f, stale: f.stale || now - f.at >= (d.feedback?.staleMs ?? 60000) };
        const override = info?.override && info.override.until > now ? info.override : undefined;
        return <tr key={d.id} data-device-id={d.id}>
          <td><button className="link" onClick={() => select({ kind: 'device', id: d.id })}>{d.name}</button><small>{d.ip}:{d.port ?? '指令指定'}</small></td>
          <td title={light.title}><span className={`devlight ${light.light}`} />{d.enabled === false ? '禁用' : light.label || '未知'}<small>{info?.lastCheckAt ? time(info.lastCheckAt) : '尚无检测结果'}</small></td>
          <td>{commandLabel(info?.lastCommand)}<small>{info?.lastCommand ? `${time(info.lastCommand.at)} · ${info.lastCommand.source}` : ''}</small></td>
          <td className={feedback?.stale ? 'warnc' : ''}>{feedbackLabel(feedback)}<small>{feedback ? `${time(feedback.at)} · 来自已校验回包` : '需配置状态查询与解析规则'}</small></td>
          <td>{override ? `手动接管至 ${time(override.until)}` : '自动日程'}<small><button disabled={busy === d.id || conn !== 'connected' || !engine?.running || d.enabled === false} onClick={() => void takeover(d.id, !!override)}>{override ? '交回自动' : '接管设备'}</button></small></td>
        </tr>;
      })}
    </tbody></table></div>
    <div className="overview-heading"><h3>场景执行进度</h3><span className="hint">完成表示动作已处理，设备状态以回读为准。</span></div>
    {(engine?.sceneRuns ?? []).length ? engine!.sceneRuns.map((run) => <details className="scene-run" key={run.id} open={run.state === 'running'}>
      <summary><strong>{run.name}</strong><span>{RUN[run.state]} · {run.steps.filter((s) => !['pending', 'waiting', 'running'].includes(s.state)).length}/{run.steps.length}</span><small>{time(run.startedAt)} · {run.source}</small></summary>
      <ol>{run.steps.map((step, i) => <li key={i}>{step.name}<span>{STEP[step.state] ?? step.state}</span></li>)}</ol>
      {run.state === 'running' && <button onClick={() => { if (window.confirm(`停止「${run.name}」后续步骤？已经发出的指令不能撤回。`)) void rpc('cancelScene', { runId: run.id }).catch((e) => toast((e as Error).message)); }}>停止后续步骤</button>}
    </details>) : <p className="hint" style={{ marginBottom: 20 }}>当前引擎尚无场景执行记录。</p>}
    <div className="overview-heading"><h3>最近需关注的记录</h3><button onClick={() => showLogTab('alerts')}>查看全部告警</button></div>
    {failures.length ? failures.map((l, i) => <div className="overview-alert" key={`${l.t}-${i}`}><span>{time(l.t)}</span><p>{l.detail}</p></div>) : <p className="hint">当前加载的日志中没有告警记录。</p>}
  </div>;
}
