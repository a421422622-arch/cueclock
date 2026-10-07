import { useEffect, useRef, useState } from 'react';
import type { ProbeRecord } from '@engine/engine.ts';
import { closePingMonitor, engineNow, rpc, toast, useStore } from '../store.ts';
import { describeDeviceState } from '../lib/deviceState.ts';
import { probeBars, probeStats } from '../lib/probeStats.ts';
import { RpcFailure } from '../transport.ts';
import { Icon } from './Icon.tsx';

const LIVE_MAX_MS = 5 * 60_000; // 持续检测最长 5 分钟自动停止，避免忘了关一直发包
const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

export async function setHealthPaused(paused: boolean): Promise<void> {
  try { await rpc('setHealthPaused', { paused }); toast(paused ? '后台在线检测已暂停：不再发送 ping / 探测包' : '后台在线检测已恢复'); }
  catch (e) { toast(`操作失败：${e instanceof RpcFailure ? e.message : String(e)}`); }
}

/** 某台设备的在线检测记录：柱状图 + 统计 + 逐条结果；可手动持续检测，也可一键暂停全部后台检测。 */
export function PingMonitor() {
  const id = useStore((s) => s.pingMonitorId);
  const device = useStore((s) => s.runningProject?.devices.find((d) => d.id === s.pingMonitorId));
  const info = useStore((s) => s.status?.engine?.devices.find((d) => d.id === s.pingMonitorId));
  const paused = useStore((s) => !!s.status?.engine?.healthPaused);
  const connected = useStore((s) => s.conn === 'connected' && !!s.status?.engine?.running);
  const [records, setRecords] = useState<ProbeRecord[]>([]);
  const [live, setLive] = useState(false);
  const [left, setLeft] = useState(0);
  const [, tick] = useState(0);
  const deviceRef = useRef(device); deviceRef.current = device;
  const method = device?.health?.mode ?? 'ping';

  // 打开时每秒取一次记录（后台自动检测和持续检测的结果都在里面）
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const load = () => rpc<{ records: ProbeRecord[] }>('getProbeHistory', { deviceId: id }).then((r) => { if (!stop) { setRecords(r.records); tick((n) => n + 1); } }).catch(() => {});
    void load();
    const t = setInterval(load, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);

  // 持续检测：窗口开着才发；Ping 每秒一次，UDP 探测每 3 秒一次（要给真实设备发查询，不能太密）；最长 5 分钟自动停
  useEffect(() => {
    if (!live || !id) return;
    const every = method === 'udp' ? 3000 : 1000, end = Date.now() + LIVE_MAX_MS;
    let busy = false;
    const run = async () => {
      if (busy || !deviceRef.current) return;
      busy = true;
      try { await rpc('probeNow', { device: deviceRef.current }); } catch { /* 失败也已记入记录 */ }
      busy = false;
      setLeft(end - Date.now());
      if (Date.now() >= end) { setLive(false); toast('持续检测已满 5 分钟，自动停止'); }
    };
    void run();
    const t = setInterval(() => void run(), every);
    return () => clearInterval(t);
  }, [live, id, method]);

  useEffect(() => { if (!connected) setLive(false); }, [connected]);
  useEffect(() => { if (!id) { setLive(false); setRecords([]); } }, [id]);
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePingMonitor(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (!id) return null;
  const stats = probeStats(records);
  const bars = probeBars(records, 60, 64);
  const light = describeDeviceState(info, device?.enabled !== false, engineNow());
  const shown = [...records].reverse().slice(0, 100);
  const canLive = connected && !!device?.health && (device.health.mode !== 'udp' || !!device.health.probe?.commandId);

  return <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) closePingMonitor(); }}>
    <div className="modal ping-monitor" role="dialog" aria-modal="true" aria-labelledby="ping-title">
      <h3 id="ping-title">在线检测记录 · {device?.name ?? '（设备不在运行配置里）'}</h3>
      <div className="mb">
        {!device && <p className="note warn">这台设备不在当前运行配置里（可能还没应用）。应用后才有检测记录。</p>}
        {device && <div className="ping-head">
          <span className="mono">{device.ip}</span>
          <span>{method === 'udp' ? 'UDP 探测' : 'Ping'} · 每 {device.health?.intervalSec ?? 30} 秒</span>
          {light.light !== 'unknown' && light.light !== 'disabled' && <span className={`light ${light.light}`} title={light.title}>● {light.label}</span>}
          {stats.failStreak > 0 && <span className="err">连续失败 {stats.failStreak} 次</span>}
        </div>}

        <div className="ping-controls">
          {live
            ? <button className="danger-outline" onClick={() => setLive(false)}><Icon name="stop" size={13} />停止持续检测{left > 0 ? `（${Math.ceil(left / 1000)} 秒后自动停）` : ''}</button>
            : <button className="primary" disabled={!canLive} onClick={() => { setLeft(LIVE_MAX_MS); setLive(true); }} title={canLive ? `开着这个窗口时每 ${method === 'udp' ? 3 : 1} 秒检测一次，最长 5 分钟自动停止，关窗口也会停` : '需要引擎运行，且设备已设置检测方式（UDP 探测还要选好探测指令）'}><Icon name="play" size={13} />开始持续检测</button>}
          <span className="grow" />
          <button className={paused ? 'primary' : ''} disabled={!connected && !paused} onClick={() => void setHealthPaused(!paused)}
            title="影响所有设备的后台自动检测；手动检测和这里的持续检测不受影响。设置会保存，引擎重启后保持。">
            {paused ? '恢复全部后台检测' : '暂停全部后台检测'}
          </button>
        </div>
        {paused && <p className="note warn">后台检测已暂停：不再自动发送 ping / 探测包，设备灯显示的是暂停前的最后结果。下面只有手动检测会更新。</p>}

        <svg className="ping-chart" viewBox="0 0 600 72" preserveAspectRatio="none" role="img" aria-label="最近检测结果柱状图">
          <line x1="0" y1="71" x2="600" y2="71" className="axis" />
          {bars.map((b) => <rect key={b.x} x={b.x * 10 + 1} y={70 - b.h} width={8} height={b.h} rx={2} className={b.ok ? 'ok' : 'bad'} />)}
        </svg>
        <div className="ping-legend"><span><i className="ok" />成功（柱高 = 耗时）</span><span><i className="bad" />失败（满高）</span><span className="dim">最近 {Math.min(60, records.length)} 次，最新在右</span></div>

        <div className="ping-stats">
          <div><small>成功率</small><b>{stats.rate === null ? '—' : `${Math.round(stats.rate * 100)}%`}</b><span>{stats.ok}/{stats.total}</span></div>
          <div><small>平均耗时</small><b>{stats.avgMs === null ? '—' : `${stats.avgMs} ms`}</b></div>
          <div><small>最快 / 最慢</small><b>{stats.minMs === null ? '—' : `${stats.minMs} / ${stats.maxMs} ms`}</b></div>
          <div><small>最近成功</small><b>{stats.lastOkAt ? clock(stats.lastOkAt) : '—'}</b></div>
        </div>

        <div className="sech">逐条结果 <span>最新在上 · 最多显示 100 条（引擎保留最近 200 条）</span></div>
        {shown.length === 0
          ? <p className="hint">还没有记录。{paused ? '后台检测已暂停；' : ''}点「开始持续检测」立即看到结果，或等下一次自动检测。</p>
          : <div className="ping-list" role="table">{shown.map((r, i) => <div key={`${r.t}-${i}`} className={r.ok ? 'ok' : 'bad'} role="row">
            <span className="mono">{clock(r.t)}</span>
            <span className="src">{r.source === 'auto' ? '自动' : '手动'}</span>
            <span className="res">{r.ok ? '✓' : '✗'}{r.rttMs !== undefined ? ` ${r.rttMs} ms` : ''}</span>
            <span className="det" title={r.detail}>{r.detail}</span>
          </div>)}</div>}
        <p className="hint">Ping 只说明网络层通不通，不代表设备上的程序正常；UDP 探测需要设备对探测指令有正确回包。</p>
      </div>
      <div className="mf"><button onClick={closePingMonitor}>关闭</button></div>
    </div>
  </div>;
}
