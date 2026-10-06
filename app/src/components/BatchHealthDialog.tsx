import { useMemo, useState } from 'react';
import type { DeviceHealthConfig } from '@engine/types.ts';
import { closeBatchHealth, edit, toast, useStore } from '../store.ts';
import { applyHealth, batchProblem, devicesByTag, devicesWithoutHealth, healthSummary, overwriteCount } from '../lib/batchHealth.ts';
import { intervalLabel, offlineDelayLabel } from '../lib/interval.ts';
import { Seg } from './fields.tsx';
import { IntervalPicker } from './IntervalPicker.tsx';

type Mode = 'none' | 'ping' | 'udp';

/** 批量设置在线检测：选方式和间隔，再勾选要应用的设备。一次应用在撤销历史里只算一步。 */
export function BatchHealthDialog() {
  const project = useStore((s) => s.project)!;
  const init = useStore((s) => s.batchHealthInit);
  const [mode, setMode] = useState<Mode>(init?.mode ?? 'ping');
  const [interval, setIntervalSec] = useState(init?.intervalSec ?? 30);
  const [probeId, setProbeId] = useState(init?.probe?.commandId ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const probeCmds = (project.commands ?? []).filter((c) => c.reply);
  const config: DeviceHealthConfig | null = useMemo(
    () => (mode === 'none' ? null : mode === 'ping' ? { mode: 'ping', intervalSec: interval } : { mode: 'udp', intervalSec: interval, probe: probeId ? { commandId: probeId } : undefined }),
    [mode, interval, probeId],
  );
  const ids = [...picked];
  const problem = batchProblem(config, ids);
  const overwrite = overwriteCount(project, ids, config);
  const tags = [...new Set(project.devices.map((d) => d.tag).filter((t): t is string => !!t))];
  const toggle = (id: string) => setPicked((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const apply = () => {
    if (problem) return;
    edit((p) => { p.devices = applyHealth(p, ids, config).devices; });
    toast(`已把${mode === 'none' ? '「不检测」' : '检测设置'}应用到 ${ids.length} 台设备`);
    closeBatchHealth();
  };

  return (
    <div className="modal-bg" onClick={closeBatchHealth}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>批量设置在线检测</h3>
        <div className="mb">
          <div className="form wide" style={{ marginBottom: 4 }}>
            <label className="fl">检测方式</label>
            <div className="fv">
              <Seg<Mode> value={mode} onChange={setMode} options={[{ value: 'none', label: '不检测（清除）' }, { value: 'ping', label: 'Ping' }, { value: 'udp', label: 'UDP 探测' }]} />
              {mode === 'ping' && <div className="hint">只说明网络层通不通，适合只收不回的设备。</div>}
              {mode === 'udp' && <div className="hint">发一条只读状态查询并校验回包。所选设备都用同一条探测指令（各自的 IP；端口以指令为准，指令没填端口才用设备默认端口）。</div>}
            </div>
            {mode !== 'none' && (
              <>
                <label className="fl">检测间隔</label>
                <div className="fv">
                  <IntervalPicker value={interval} onChange={setIntervalSec} />
                  <div className="hint">连续失败 3 次判定离线，按当前间隔约 {offlineDelayLabel(interval)} 后发现。</div>
                </div>
              </>
            )}
            {mode === 'udp' && (
              <>
                <label className="fl">探测指令</label>
                <div className="fv">
                  <select className={probeId ? '' : 'bad'} value={probeId} onChange={(e) => setProbeId(e.target.value)}>
                    <option value="">选择指令…</option>
                    {probeCmds.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {probeCmds.length === 0 && <div className="hint err">指令库里还没有开了回包校验的指令，请先添加。</div>}
                </div>
              </>
            )}
          </div>

          <div className="sech" style={{ margin: '6px 0 2px' }}>应用到这些设备 <span>已选 {ids.length} / {project.devices.length}</span></div>
          <div className="row" style={{ gap: 6 }}>
            <button onClick={() => setPicked(new Set(project.devices.map((d) => d.id)))}>全选</button>
            <button onClick={() => setPicked(new Set())}>全不选</button>
            <button onClick={() => setPicked(new Set(devicesWithoutHealth(project)))}>仅未设置检测的</button>
            {tags.map((t) => <button key={t} onClick={() => setPicked(new Set(devicesByTag(project, t)))}>标签：{t}</button>)}
          </div>
          <div className="bhlist">
            {project.devices.length === 0 && <div className="empty">还没有设备。</div>}
            {project.devices.map((d) => (
              <label key={d.id} className={`bhrow ${picked.has(d.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                <span className="nm">{d.name}{d.enabled === false && <span className="tag" style={{ marginLeft: 6 }}>已禁用</span>}</span>
                <span className="mono dim">{d.ip}</span>
                <span className="dim">{healthSummary(d.health, intervalLabel)}</span>
              </label>
            ))}
          </div>
          {overwrite > 0 && <div className="note warn" style={{ margin: 0 }}>其中 {overwrite} 台设备原来已有不同的检测设置，将被覆盖。</div>}
          {problem && ids.length > 0 && <div className="hint err">{problem}</div>}
        </div>
        <div className="mf">
          <span className="dim" style={{ marginRight: 'auto', fontSize: 12 }}>应用后可以用「撤销」一步还原</span>
          <button onClick={closeBatchHealth}>取消</button>
          <button className="primary" disabled={!!problem} onClick={apply}>应用到 {ids.length} 台设备</button>
        </div>
      </div>
    </div>
  );
}
