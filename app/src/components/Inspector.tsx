import { useEffect, useState } from 'react';
import type { Command, CommandParam, DayKind, Device, DeviceHealthConfig, Group, Rule, Terminator, Timeline, Trigger } from '@engine/types.ts';
import { placeholdersOf } from '@engine/commands.ts';
import { allActions, sceneRefCount } from '../lib/usage.ts';
import { describeDeviceState } from '../lib/deviceState.ts';
import { offlineDelayLabel } from '../lib/interval.ts';
import { IntervalPicker } from './IntervalPicker.tsx';
import type { Pad, PadTile } from '@engine/types.ts';
import { changeKind, duplicateTile, groupNames, moveTile, sliderOutput, sliderRange, sliderSteps } from '../lib/pad.ts';
import { GROUP_COLORS } from '../lib/colors.ts';
import { setPadId } from '../store.ts';
import { formatTime, parseTime } from '@engine/time.ts';
import { isDateKey } from '@engine/calendar.ts';
import { edit, engineNow, openBatchHealth, rpc, select, toast, useStore } from '../store.ts';
import { DAY_KIND_LABEL, genId, ruleText } from '../lib/labels.ts';
import { ActionList, SendEditor } from './ActionEditor.tsx';
import { TestResult, useCommandTest } from './TestSend.tsx';
import { requiredParams } from '../lib/commandTest.ts';
import { Check, ColorField, Field, NumInput, Seg, ValidatedInput } from './fields.tsx';
import { RpcFailure } from '../transport.ts';
import { cloneMode, cueDevices } from '../lib/timeline.ts';
import { deviceColor, modeColor } from '../lib/colors.ts';
import { Icon } from './Icon.tsx';

export function Inspector() {
  const sel = useStore((s) => s.sel);
  const locked = useStore((s) => s.lock.enabled && !s.lock.unlocked);
  const project = useStore((s) => s.project)!;
  let title = '检查器';
  let body: React.ReactNode = <div className="empty big">选中模式、目标或事件点进行编辑。双击目标小时间轴可以为该目标新建事件点。</div>;

  if (sel?.kind === 'cue') {
    const tl = project.timelines.find((t) => t.id === sel.timelineId);
    if (tl?.cues.some((c) => c.id === sel.cueId)) {
      title = '事件点';
      body = <CueInspector key={sel.cueId} timelineId={sel.timelineId} cueId={sel.cueId} />;
    }
  } else if (sel?.kind === 'timeline' && project.timelines.some((t) => t.id === sel.id)) {
    title = '日程模式';
    body = <TimelineInspector key={sel.id} id={sel.id} />;
  } else if (sel?.kind === 'group' && project.groups.some((g) => g.id === sel.id)) {
    title = '组';
    body = <GroupInspector key={sel.id} id={sel.id} />;
  } else if (sel?.kind === 'device' && project.devices.some((d) => d.id === sel.id)) {
    title = '设备';
    body = <DeviceInspector key={sel.id} id={sel.id} />;
  } else if (sel?.kind === 'padTile' && project.pads?.find((p) => p.id === sel.padId)?.tiles.some((t) => t.id === sel.tileId)) {
    title = '面板按钮';
    body = <PadTileInspector key={`${sel.padId}/${sel.tileId}`} padId={sel.padId} tileId={sel.tileId} />;
  } else if (sel?.kind === 'pad' && (project.pads ?? []).some((p) => p.id === sel.id)) {
    title = '操作面板';
    body = <PadInspector key={sel.id} id={sel.id} />;
  } else if (sel?.kind === 'scene' && (project.scenes ?? []).some((c) => c.id === sel.id)) {
    title = '场景';
    body = <SceneInspector key={sel.id} id={sel.id} />;
  } else if (sel?.kind === 'command' && (project.commands ?? []).some((c) => c.id === sel.id)) {
    title = 'UDP 指令';
    body = <CommandInspector key={sel.id} id={sel.id} />;
  } else if (sel?.kind === 'trigger' && project.triggers.some((t) => t.id === sel.id)) {
    title = 'UDP 触发器';
    body = <TriggerInspector key={sel.id} id={sel.id} />;
  }
  return (
    <section className="insp">
      <h3>{title}</h3>
      <div className="ibody" inert={locked}>{body}</div>
    </section>
  );
}

// ───────────── 事件点 ─────────────

function CueInspector({ timelineId, cueId }: { timelineId: string; cueId: string }) {
  const project = useStore((s) => s.project)!;
  const info = useStore((s) => s.status?.engine?.timelines.find((t) => t.id === timelineId));
  const tl = project.timelines.find((t) => t.id === timelineId)!;
  const cue = tl.cues.find((c) => c.id === cueId)!;
  const sel = useStore((s) => s.sel);
  const focusedAction = sel?.kind === 'cue' ? sel.actionId : undefined;
  const targets = cueDevices(project, cue);
  const draftPending = useStore((s) => s.saveState !== 'saved');
  useEffect(() => {
    if (focusedAction) document.querySelector(`[data-action-id="${CSS.escape(focusedAction)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusedAction]);
  const patch = (fn: (c: typeof cue) => void) =>
    edit((p) => {
      const c = p.timelines.find((t) => t.id === timelineId)?.cues.find((x) => x.id === cueId);
      if (c) fn(c);
    });

  const run = async () => {
    try {
      const r = await rpc<{ actions: number }>('runCue', { timelineId, cueId });
      toast(`已手动执行（${r.actions} 个执行点），结果见日志`);
    } catch (e) {
      toast(`执行失败：${(e as Error).message}`);
    }
  };

  return (
    <>
      {info && !info.active && <div className="note warn">这个模式今天不生效：{info.reason}。手动执行不受影响。</div>}
      {targets.length > 1 && <div className="note">此事件关联 {targets.map((d) => d.name).join('、')}。在任一时间轴拖动它，会同步移动该事件的全部动作。</div>}
      <div className="form">
        <Field label="名称">
          <input value={cue.name} onChange={(e) => patch((c) => (c.name = e.target.value))} />
        </Field>
        <Field label="时间" hint="HH:MM:SS.mmm，精确到毫秒；也可在时间线上拖动">
          <ValidatedInput mono value={cue.time} validate={(v) => (parseTime(v) === null ? '格式应为 09:00 / 09:00:00 / 09:00:00.250' : null)} onCommit={(v) => patch((c) => (c.time = formatTime(parseTime(v)!)))} />
        </Field>
        <Field label="所属">
          <span className="dim">{tl.name}</span>
        </Field>
        <Field label="默认目标" hint="为此事件新加动作时预填；已有动作仍以各自的目标设置为准">
          <select value={cue.defaultTarget ?? ''} onChange={(e) => patch((c) => (c.defaultTarget = e.target.value || undefined))}>
            <option value="">不预填</option>
            {[...new Set(project.devices.map((d) => d.tag).filter(Boolean))].map((tag) => <option key={tag} value={`tag:${tag}`}>标签：{tag}</option>)}
            {project.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="启用">
          <Check checked={cue.enabled !== false} onChange={(v) => patch((c) => (c.enabled = v))} label="参与调度" />
        </Field>
      </div>
      <div className="sech">动作（按顺序，延时会让后面的整体顺延） <span>{cue.actions.length}</span></div>
      <ActionList actions={cue.actions} defaultTarget={cue.defaultTarget} focusedAction={focusedAction} onChange={(next) => patch((c) => (c.actions = next))} />
      <div className="foot">
        <button disabled={draftPending} title={draftPending ? '先应用草稿后再立即执行' : undefined} onClick={run}><Icon name="play" size={12} />立即执行</button>
        <button onClick={() => {
          const id = genId('c');
          edit((p) => {
            const t = p.timelines.find((x) => x.id === timelineId)!;
            const src = t.cues.find((x) => x.id === cueId)!;
            t.cues.push({ ...structuredClone(src), id, name: src.name + ' 副本', actions: src.actions.map((a) => ({ ...structuredClone(a), id: genId('a') })) });
          });
          select({ kind: 'cue', timelineId, cueId: id });
        }}>复制</button>
        <button className="danger" onClick={() => {
          if (!window.confirm(`删除事件点「${cue.name}」？`)) return;
          edit((p) => { const t = p.timelines.find((x) => x.id === timelineId)!; t.cues = t.cues.filter((x) => x.id !== cueId); });
          select({ kind: 'timeline', id: timelineId });
        }}>删除</button>
      </div>
    </>
  );
}

// ───────────── 时间线与规则 ─────────────

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_KINDS: DayKind[] = ['workday', 'makeupWorkday', 'weekend', 'holiday'];

function TimelineInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const info = useStore((s) => s.status?.engine?.timelines.find((t) => t.id === id));
  const tl = project.timelines.find((t) => t.id === id)!;
  const group = project.groups.find((g) => g.id === tl.groupId);
  const patch = (fn: (t: Timeline) => void) => edit((p) => { const t = p.timelines.find((x) => x.id === id); if (t) fn(t); });
  const rule: Rule = tl.rule ?? {};
  const setRule = (fn: (r: Rule) => void) => patch((t) => { const r = structuredClone(t.rule ?? {}); fn(r); t.rule = r; });

  return (
    <>
      {info && <div className={`note ${info.active ? 'ok' : 'warn'}`}>今天：{info.active ? '生效' : '不生效'} · {info.reason}</div>}
      <div className="form">
        <Field label="名称"><input value={tl.name} onChange={(e) => patch((t) => (t.name = e.target.value))} /></Field>
        <Field label="模式颜色"><ColorField value={modeColor(project, id)} label="模式颜色" onChange={(v) => patch((t) => (t.color = v))} /></Field>
        <Field label="所属组">
          <select value={tl.groupId ?? ''} onChange={(e) => patch((t) => (t.groupId = e.target.value || undefined))}>
            <option value="">（不分组）</option>
            {project.groups.map((g) => <option key={g.id} value={g.id}>{g.name}（{g.mode === 'exclusive' ? '互斥' : '并行'}）</option>)}
          </select>
        </Field>
        <Field label="优先级" hint={group?.mode === 'exclusive' ? '数字越小越优先；同组同一天只运行优先级最高的一条' : '仅「互斥」组内有意义'}>
          <NumInput value={tl.priority ?? 100} min={1} width={64} onChange={(v) => patch((t) => (t.priority = v ?? 100))} />
        </Field>
        <Field label="启用"><Check checked={tl.enabled !== false} onChange={(v) => patch((t) => (t.enabled = v))} label="参与调度" /></Field>
      </div>

      <div className="sech">生效规则 <span>{ruleText(tl.rule)}</span></div>
      <div className="hint pad">下面任选其一满足即生效；都不选 = 每天。「排除日期」永远优先。</div>
      <div className="form">
        <Field label="日子类型" hint="法定节假日、调休日来自项目的节假日日历">
          <div className="checks">
            {DAY_KINDS.map((k) => (
              <Check key={k} label={DAY_KIND_LABEL[k]} checked={rule.dayKinds?.includes(k) ?? false}
                onChange={(on) => setRule((r) => { const s = new Set(r.dayKinds ?? []); on ? s.add(k) : s.delete(k); r.dayKinds = [...s]; })} />
            ))}
          </div>
        </Field>
        <Field label="星期">
          <div className="wk">
            {WEEK.map((w, d) => (
              <span key={d} className={rule.weekdays?.includes(d) ? 'on' : ''}
                onClick={() => setRule((r) => { const s = new Set(r.weekdays ?? []); s.has(d) ? s.delete(d) : s.add(d); r.weekdays = [...s].sort(); })}>{w}</span>
            ))}
          </div>
        </Field>
        <Field label="日期范围">
          <div className="list">
            {(rule.dateRanges ?? []).map((r, i) => (
              <div key={i} className="row">
                <DateInput value={r.from} onChange={(v) => setRule((x) => (x.dateRanges![i]!.from = v))} /> 至
                <DateInput value={r.to} onChange={(v) => setRule((x) => (x.dateRanges![i]!.to = v))} />
                <button className="ico" onClick={() => setRule((x) => (x.dateRanges = x.dateRanges!.filter((_, j) => j !== i)))}><Icon name="x" size={13} /></button>
              </div>
            ))}
            <button onClick={() => setRule((r) => { const d = today(); r.dateRanges = [...(r.dateRanges ?? []), { from: d, to: d }]; })}>＋ 添加范围</button>
          </div>
        </Field>
        <DateList label="指定日期" values={rule.dates} onChange={(v) => setRule((r) => (r.dates = v))} />
        <DateList label="排除日期" values={rule.excludeDates} onChange={(v) => setRule((r) => (r.excludeDates = v))} />
      </div>
      <div className="foot">
        <button onClick={() => {
          const nid = genId('t');
          edit((p) => {
            const src = p.timelines.find((t) => t.id === id)!;
            p.timelines.push(cloneMode(src, nid, genId));
          });
          select({ kind: 'timeline', id: nid });
        }}>复制模式（先禁用）</button>
        <button className="danger" onClick={() => {
          if (!window.confirm(`删除模式「${tl.name}」及其 ${tl.cues.length} 个事件点？`)) return;
          edit((p) => (p.timelines = p.timelines.filter((t) => t.id !== id)));
          select(null);
        }}>删除模式</button>
      </div>
    </>
  );
}

const today = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function DateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="date" value={isDateKey(value) ? value : ''} onChange={(e) => e.target.value && onChange(e.target.value)} />;
}

function DateList({ label, values, onChange }: { label: string; values?: string[]; onChange: (v: string[]) => void }) {
  const list = values ?? [];
  return (
    <Field label={label}>
      <div className="list">
        <div className="chips">
          {list.map((d) => <span key={d} className="chip">{d}<i onClick={() => onChange(list.filter((x) => x !== d))}>×</i></span>)}
        </div>
        <DateInput value="" onChange={(v) => !list.includes(v) && onChange([...list, v].sort())} />
      </div>
    </Field>
  );
}

function GroupInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const g = project.groups.find((x) => x.id === id)!;
  const patch = (fn: (g: Group) => void) => edit((p) => { const x = p.groups.find((y) => y.id === id); if (x) fn(x); });
  return (
    <>
      <div className="form">
        <Field label="名称"><input value={g.name} onChange={(e) => patch((x) => (x.name = e.target.value))} /></Field>
        <Field label="模式" hint={g.mode === 'exclusive' ? '同一天只运行优先级最高、规则命中的一条（平日/周末/节假日自动切换）' : '规则命中的都运行'}>
          <Seg value={g.mode} options={[{ value: 'exclusive', label: '互斥（自动切换）' }, { value: 'parallel', label: '并行' }]} onChange={(m) => patch((x) => (x.mode = m))} />
        </Field>
      </div>
      <div className="foot">
        <button className="danger" onClick={() => {
          if (!window.confirm(`删除组「${g.name}」？组内时间线会变成未分组，不会被删除。`)) return;
          edit((p) => { p.timelines.forEach((t) => t.groupId === id && (t.groupId = undefined)); p.groups = p.groups.filter((x) => x.id !== id); });
          select(null);
        }}>删除组</button>
      </div>
    </>
  );
}

// ───────────── 设备 ─────────────

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validIp = (v: string) => { const m = IPV4.exec(v); return m && m.slice(1).every((x) => Number(x) <= 255) ? null : '不是合法的 IPv4 地址'; };

function DeviceInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const d = project.devices.find((x) => x.id === id)!;
  const patch = (fn: (d: Device) => void) => edit((p) => { const x = p.devices.find((y) => y.id === id); if (x) fn(x); });
  const used =
    allActions(project).filter((a) => (a.type === 'udp' || a.type === 'command') && (a.targets ?? []).includes(id)).length +
    (project.commands ?? []).filter((c) => c.targets.includes(id)).length;
  const [payload, setPayload] = useState('');
  const [testPort, setTestPort] = useState<number | undefined>(d.port);
  const [res, setRes] = useState('');

  const send = async () => {
    setRes('发送中…');
    try {
      const r = await rpc<{ result: string }>('testSend', { ip: d.ip, port: testPort, format: d.format ?? 'ascii', payload, terminator: d.terminator });
      setRes(r.result === 'sent' ? '已发送' : r.result);
    } catch (e) {
      setRes(e instanceof RpcFailure ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="form">
        <Field label="名称"><input value={d.name} onChange={(e) => patch((x) => (x.name = e.target.value))} /></Field>
        <Field label="目标颜色"><ColorField value={deviceColor(project, id)} label="目标颜色" onChange={(v) => patch((x) => (x.color = v))} /></Field>
        <Field label="IP"><ValidatedInput mono value={d.ip} validate={validIp} onCommit={(v) => patch((x) => (x.ip = v))} /></Field>
        <Field label="默认端口" hint="可不填。每条指令里可以单独设置端口，指令里没填才用这里的">
          <NumInput value={d.port} min={1} max={65535} width={80} allowEmpty onChange={(v) => patch((x) => (x.port = v))} />
        </Field>
        <Field label="默认格式">
          <Seg value={d.format ?? 'ascii'} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} onChange={(f) => patch((x) => (x.format = f))} />
        </Field>
        <Field label="结束符" hint="ASCII 内容发送时自动追加；动作里可单独覆盖">
          <select value={d.terminator ?? 'none'} onChange={(e) => patch((x) => (x.terminator = e.target.value as Terminator))}>
            <option value="none">无</option><option value="cr">\r</option><option value="lf">\n</option><option value="crlf">\r\n</option>
          </select>
        </Field>
        <Field label="标签" hint="动作里可以直接选「标签」作为目标，一次发给同标签的所有设备">
          <input value={d.tag ?? ''} placeholder="如：灯光、投影" onChange={(e) => patch((x) => (x.tag = e.target.value || undefined))} />
        </Field>
        <Field label="PJLink 密码" hint="只用于「协议 = PJLink」的指令；设备没设密码就留空。明文保存在配置文件里——这是投影机的网络控制口令，别填重要密码。">
          <input type="password" autoComplete="off" value={d.password ?? ''} placeholder="（可选）" onChange={(e) => patch((x) => (x.password = e.target.value || undefined))} />
        </Field>
        <Field label="启用"><Check checked={d.enabled !== false} onChange={(v) => patch((x) => (x.enabled = v))} label="参与发送（关闭后动作跳过此设备）" /></Field>
      </div>
      <HealthSection device={d} patch={patch} />
      <FeedbackSection device={d} patch={patch} />
      <div className="sech">测试发送</div>
      <div className="form">
        <Field label="端口"><NumInput value={testPort} min={1} max={65535} width={80} allowEmpty onChange={setTestPort} /></Field>
        <Field label="内容" hint={res}>
          <input className="mono" value={payload} placeholder={(d.format ?? 'ascii') === 'hex' ? 'A5 01 FF' : 'SCENE 1'} onChange={(e) => setPayload(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && payload && void send()} />
        </Field>
      </div>
      <div className="foot">
        <button className="primary" disabled={!payload || testPort === undefined} onClick={send}>发送</button>
        <button className="danger" onClick={() => {
          if (!window.confirm(used ? `「${d.name}」被 ${used} 处（指令或动作）引用，删除后会报错。仍要删除？` : `删除设备「${d.name}」？`)) return;
          edit((p) => (p.devices = p.devices.filter((x) => x.id !== id)));
          select(null);
        }}>删除设备</button>
      </div>
    </>
  );
}

// ───────────── 触发器 ─────────────

function TriggerInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const t = project.triggers.find((x) => x.id === id)!;
  const patch = (fn: (t: Trigger) => void) => edit((p) => { const x = p.triggers.find((y) => y.id === id); if (x) fn(x); });
  const any = t.allowFrom.includes('*');
  return (
    <>
      <div className="form">
        <Field label="名称"><input value={t.name} onChange={(e) => patch((x) => (x.name = e.target.value))} /></Field>
        <Field label="监听端口"><NumInput value={t.port} min={1} max={65535} width={80} onChange={(v) => v !== undefined && patch((x) => (x.port = v))} /></Field>
        <Field label="来源" hint={any ? '⚠ 允许任意来源：局域网内任何设备都能触发' : '只接受这些来源，逗号分隔，支持网段 192.168.10.0/24；* 表示任意'}>
          <input className={`mono ${any ? 'warnb' : ''}`} value={t.allowFrom.join(', ')} onChange={(e) => patch((x) => (x.allowFrom = e.target.value.split(/[,\s]+/).filter(Boolean)))} />
        </Field>
        <Field label="口令前缀" hint="收到的内容必须以它开头（会先剥离）。UDP 是明文，只能防误触，防不了抓包">
          <input className="mono" value={t.passcode ?? ''} placeholder="（可选）如 KEY1:" onChange={(e) => patch((x) => (x.passcode = e.target.value || undefined))} />
        </Field>
        <Field label="匹配">
          <span className="row">
            <select value={t.match.kind} onChange={(e) => patch((x) => { x.match.kind = e.target.value as Trigger['match']['kind']; if (x.match.kind === 'regex') x.match.format = 'ascii'; })}>
              <option value="exact">完全匹配</option><option value="prefix">前缀</option><option value="contains">包含</option><option value="regex">正则</option>
            </select>
            {t.match.kind !== 'regex' && <Seg value={t.match.format} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} onChange={(f) => patch((x) => (x.match.format = f))} />}
          </span>
          <input className="mono" style={{ marginTop: 6 }} value={t.match.pattern} onChange={(e) => patch((x) => (x.match.pattern = e.target.value))} />
        </Field>
        <Field label="限制">
          <span className="row">防抖 <NumInput value={t.debounceMs ?? 0} width={60} onChange={(v) => patch((x) => (x.debounceMs = v || undefined))} />ms　每分钟最多 <NumInput value={t.maxPerMinute} width={52} allowEmpty min={1} onChange={(v) => patch((x) => (x.maxPerMinute = v))} />次</span>
        </Field>
        <Field label="二次确认" hint="危险动作（如全关）建议开启：窗口内收到第二个匹配包才执行">
          <span className="row">
            <Check checked={t.requireConfirm === true} onChange={(v) => patch((x) => (x.requireConfirm = v || undefined))} label="需要" />
            {t.requireConfirm && <>窗口 <NumInput value={t.confirmWindowMs ?? 5000} min={100} width={64} onChange={(v) => patch((x) => (x.confirmWindowMs = v))} />ms</>}
          </span>
        </Field>
      </div>
      <div className="sech">触发后执行的动作 <span>{t.actions.length}</span></div>
      {t.match.kind === 'regex' && <div className="hint pad">指令参数和自定义 UDP 内容可用 $1~$9 捕获组、$0 整个内容（去口令和尾换行）、$$ 字面 $。捕获值按字面代入，反斜杠不会变成发送转义。</div>}
      <ActionList actions={t.actions} triggerTemplate={t.match.kind === 'regex'} onChange={(next) => patch((x) => (x.actions = next))} />
      <div className="foot">
        <button className="danger" onClick={() => {
          if (!window.confirm(`删除触发器「${t.name}」？`)) return;
          edit((p) => (p.triggers = p.triggers.filter((x) => x.id !== id)));
          select(null);
        }}>删除触发器</button>
      </div>
    </>
  );
}


// ───────────── UDP 指令库 ─────────────

function CommandInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const cmd = (project.commands ?? []).find((c) => c.id === id)!;
  const patch = (fn: (c: Command) => void) => edit((p) => { const c = p.commands?.find((x) => x.id === id); if (c) fn(c); });
  const params = cmd.params ?? [];
  const used = placeholdersOf(cmd.payload);
  const undeclared = used.filter((u) => !params.some((p) => p.name === u));
  const unused = params.filter((p) => !used.includes(p.name));
  const refs = allActions(project).filter((a) => a.type === 'command' && a.commandId === id).length;

  // 预览时没有默认值的参数用占位值代入，免得预览里全是空
  const previewValues = Object.fromEntries(params.map((p) => [p.name, p.default ?? (cmd.format === 'hex' ? '00' : cmd.format === 'osc' ? '0' : '·')]));
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const tester = useCommandTest();
  const missing = requiredParams(cmd).filter((n) => !(testArgs[n] ?? '').length);

  const setParam = (i: number, p: Partial<CommandParam>) => patch((c) => { c.params = (c.params ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)); });

  return (
    <>
      {refs > 0 && <div className="note ok">这条指令被 {refs} 个动作使用。修改后，这些动作都会跟着变。</div>}
      <div className="form">
        <Field label="名称"><input value={cmd.name} onChange={(e) => patch((c) => (c.name = e.target.value))} /></Field>
        <Field label="说明"><input value={cmd.note ?? ''} placeholder="（可选）" onChange={(e) => patch((c) => (c.note = e.target.value || undefined))} /></Field>
      </div>
      <div className="testbar">
        {params.map((p) => (
          <label key={p.name} className="testarg">{p.label || p.name}
            <input className="mono" value={testArgs[p.name] ?? ''} placeholder={p.default ?? '必填'} onChange={(e) => setTestArgs({ ...testArgs, [p.name]: e.target.value })} />
          </label>
        ))}
        <button className="primary" disabled={tester.busy || missing.length > 0} title={missing.length ? `先填写参数：${missing.join('、')}` : '真的会发出，用的是当前正在编辑的内容（即使还没应用）'} onClick={() => void tester.run(cmd, testArgs)}><Icon name="play" size={12} />测试发送</button>
        <TestResult state={tester} />
      </div>
      <div className="sech">发送内容</div>
      <div className="act"><div className="ab"><SendEditor v={cmd} previewValues={previewValues} onChange={(pt) => patch((c) => Object.assign(c, pt))} /></div></div>

      <div className="sech">参数 <span>内容里写 {'{{名字}}'}，使用时填值</span></div>
      <div className="hint pad">例：内容写 <code>SCENE {'{{场景号}}'}</code>，再添加参数「场景号」。时间线上选用这条指令时，只需要填场景号。</div>
      {params.map((p, i) => (
        <div key={i} className="paramrow">
          <input className="mono" style={{ width: 96 }} value={p.name} placeholder="参数名" onChange={(e) => setParam(i, { name: e.target.value })} />
          <input style={{ width: 90 }} value={p.label ?? ''} placeholder="显示名" onChange={(e) => setParam(i, { label: e.target.value || undefined })} />
          <input className="mono" style={{ width: 90 }} value={p.default ?? ''} placeholder="默认值" onChange={(e) => setParam(i, { default: e.target.value === '' ? undefined : e.target.value })} />
          <button className="ico" onClick={() => patch((c) => (c.params = (c.params ?? []).filter((_, j) => j !== i)))}><Icon name="x" size={13} /></button>
        </div>
      ))}
      {undeclared.length > 0 && (
        <div className="note warn">
          内容里用了 {undeclared.map((u) => `{{${u}}}`).join(' ')}，但还没有声明。
          <button style={{ marginLeft: 6 }} onClick={() => patch((c) => (c.params = [...(c.params ?? []), ...undeclared.map((name) => ({ name }))]))}>一键添加</button>
        </div>
      )}
      {unused.length > 0 && <div className="hint">参数 {unused.map((p) => p.name).join('、')} 没有在内容里使用。</div>}
      <button className="addact" onClick={() => patch((c) => (c.params = [...(c.params ?? []), { name: `参数${(c.params ?? []).length + 1}` }]))}>＋ 添加参数</button>

      <div className="foot">
        <button onClick={() => {
          const nid = genId('cmd');
          edit((p) => { const src = p.commands!.find((c) => c.id === id)!; p.commands!.push({ ...structuredClone(src), id: nid, name: src.name + ' 副本' }); });
          select({ kind: 'command', id: nid });
        }}>复制</button>
        <button className="danger" onClick={() => {
          if (!window.confirm(refs ? `「${cmd.name}」正被 ${refs} 个动作使用，删除后这些动作会报错。仍要删除？` : `删除指令「${cmd.name}」？`)) return;
          edit((p) => (p.commands = (p.commands ?? []).filter((c) => c.id !== id)));
          select(null);
        }}>删除指令</button>
      </div>
    </>
  );
}


// ───────────── 场景库 ─────────────

function SceneInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const scene = (project.scenes ?? []).find((c) => c.id === id)!;
  const patch = (fn: (s: typeof scene) => void) => edit((p) => { const x = p.scenes?.find((y) => y.id === id); if (x) fn(x); });
  const refs = sceneRefCount(project, id);
  const [res, setRes] = useState<{ text: string; bad: boolean } | null>(null);

  const test = async () => {
    setRes({ text: '执行中…', bad: false });
    try {
      const r = await rpc<{ actions: number }>('runScene', { scene });
      setRes({ text: `已启动（${r.actions} 个执行点），进度见运行总览，结果见日志`, bad: false });
    } catch (e) {
      setRes({ text: e instanceof RpcFailure ? e.message : String(e), bad: true });
    }
  };

  return (
    <>
      {refs > 0 && <div className="note ok">这个场景被 {refs} 个动作使用。修改后，这些地方都会跟着变。</div>}
      <div className="form">
        <Field label="名称"><input value={scene.name} onChange={(e) => patch((s) => (s.name = e.target.value))} /></Field>
        <Field label="执行方式" hint={scene.execution === 'sequence' ? '按列表顺序执行，等上一动作结果再执行下一步。有回包校验才会等待确认；无回包只等待发出。延时/偏移相对前一步完成。' : '保持现有按偏移时间发送的方式，各动作可并行等待回包。'}><Seg value={scene.execution ?? 'timed'} options={[{ value: 'timed', label: '按时间' }, { value: 'sequence', label: '按顺序' }]} onChange={(v) => patch((s) => { s.execution = v; })} /></Field>
        {scene.execution === 'sequence' && <Field label="失败策略"><Seg value={scene.onFailure ?? 'stop'} options={[{ value: 'stop', label: '停止后续' }, { value: 'continue', label: '继续后续' }]} onChange={(v) => patch((s) => { s.onFailure = v; })} /></Field>}
        <Field label="说明"><input value={scene.note ?? ''} placeholder="（可选）" onChange={(e) => patch((s) => (s.note = e.target.value || undefined))} /></Field>
      </div>
      <div className="sech">场景里的动作（自成一条小时间线，延时只在场景内部生效） <span>{scene.actions.length}</span></div>
      <div className="hint pad">可以放「使用指令」「自定义 UDP」「延时」。场景里不能再套场景，也不能放「时间线控制」。</div>
      <ActionList inScene actions={scene.actions} onChange={(next) => patch((s) => (s.actions = next))} />
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="primary" onClick={test}><Icon name="play" size={12} />立即执行这个场景</button>
        {res && <span className={`hint ${res.bad ? 'err' : 'okc'}`}>{res.text}</span>}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>用的是当前正在编辑的内容（即使还没保存），按配置方式执行；应用配置会取消仍在等待的旧动作链。</div>
      <div className="foot">
        <button onClick={() => {
          const nid = genId('scene');
          edit((p) => { const src = p.scenes!.find((c) => c.id === id)!; p.scenes!.push({ ...structuredClone(src), id: nid, name: src.name + ' 副本', actions: src.actions.map((a) => ({ ...structuredClone(a), id: genId('a') })) }); });
          select({ kind: 'scene', id: nid });
        }}>复制</button>
        <button className="danger" onClick={() => {
          if (!window.confirm(refs ? `「${scene.name}」正被 ${refs} 个动作使用，删除后这些动作会报错。仍要删除？` : `删除场景「${scene.name}」？`)) return;
          edit((p) => (p.scenes = (p.scenes ?? []).filter((c) => c.id !== id)));
          select(null);
        }}>删除场景</button>
      </div>
    </>
  );
}


// ───────────── 设备在线检测 ─────────────

type HealthMode = 'none' | 'ping' | 'udp';

function FeedbackSection({ device, patch }: { device: Device; patch: (fn: (d: Device) => void) => void }) {
  const config = device.feedback;
  const [fields, setFields] = useState('');
  useEffect(() => setFields(config?.fields.map((f) => `${f.label}=${f.group}`).join('\n') ?? ''), [config?.fields]);
  return <>
    <div className="sech">设备状态回读</div>
    <div className="form">
      <Field label="解析状态" hint="只解析状态查询或动作的已校验回包；Ping 和普通 OK 不代表实际状态。请按设备协议填写。">
        <Check checked={!!config} label="启用回包状态解析" onChange={(on) => patch((d) => { d.feedback = on ? { format: 'ascii', pattern: '', fields: [{ label: '状态', group: 1 }], staleMs: 60000 } : undefined; })} />
      </Field>
      {config && <>
        <Field label="格式"><Seg value={config.format} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} onChange={(v) => patch((d) => { d.feedback!.format = v; })} /></Field>
        <Field label="状态正则" hint={config.format === 'hex' ? '匹配大写连续 HEX，例如 ^AA(01|00)55$；括号是捕获组。' : '例如 ^POWER=(ON|OFF)$；括号是捕获组。末尾换行会移除。'}>
          <input className="mono" value={config.pattern} onChange={(e) => patch((d) => { d.feedback!.pattern = e.target.value; })} />
        </Field>
        <Field label="字段" hint="每行 名称=捕获组序号，例如 电源=1。离开输入框后检查。">
          <textarea value={fields} rows={3} onChange={(e) => setFields(e.target.value)} onBlur={() => {
            const rows = fields.split('\n').filter((x) => x.trim());
            if (!rows.length || rows.some((x) => !/^.{1,50}=\d+$/.test(x))) { toast('状态字段格式应为 名称=捕获组序号'); return; }
            patch((d) => { d.feedback!.fields = rows.map((x) => { const pos = x.lastIndexOf('='); return { label: x.slice(0, pos).trim(), group: Number(x.slice(pos + 1)) }; }); });
          }} />
        </Field>
        <Field label="过期秒数" hint="超过期限未收到新状态，会显示过期。"><NumInput value={(config.staleMs ?? 60000) / 1000} min={1} max={86400} width={80} onChange={(v) => patch((d) => { d.feedback!.staleMs = (v ?? 60) * 1000; })} /></Field>
      </>}
    </div>
  </>;
}

/** 每台设备单独选检测方式：不检测 / Ping（只判网络通不通）/ UDP 探测（发只读查询并校验回包，最准）。 */
function HealthSection({ device: d, patch }: { device: Device; patch: (fn: (d: Device) => void) => void }) {
  const project = useStore((s) => s.project)!;
  const info = useStore((s) => s.status?.engine?.devices.find((x) => x.id === d.id));
  const h = d.health;
  const mode: HealthMode = h?.mode ?? 'none';
  const probeCmds = (project.commands ?? []).filter((c) => c.reply);
  const [res, setRes] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const st = describeDeviceState(info, d.enabled !== false, engineNow());

  const setMode = (m: HealthMode) => {
    // 没有可用的探测指令时不允许切到 UDP 探测：否则配置会处于无效状态，自动保存被卡住，连别的修改也存不了
    if (m === 'udp' && probeCmds.length === 0) {
      toast('指令库里还没有开了回包校验的指令。请先在「指令」页签添加一条只读的状态查询，并开启回包校验。');
      return;
    }
    patch((x) => {
      x.health = m === 'none' ? undefined : m === 'ping' ? { mode: 'ping', intervalSec: x.health?.intervalSec ?? 30 } : { mode: 'udp', intervalSec: x.health?.intervalSec ?? 30, probe: x.health?.probe };
    });
  };
  const set = (fn: (c: DeviceHealthConfig) => void) => patch((x) => { if (x.health) fn(x.health); });

  const probe = async () => {
    setBusy(true);
    setRes(null);
    try {
      const r = await rpc<{ ok: boolean; detail: string }>('probeNow', { device: d });
      setRes({ text: r.detail, ok: r.ok });
    } catch (e) {
      setRes({ text: e instanceof RpcFailure ? e.message : String(e), ok: false });
    }
    setBusy(false);
  };

  return (
    <>
      <div className="sech" style={{ marginTop: 6 }}>在线检测 {st.light !== 'unknown' && st.light !== 'disabled' && <span className={`light ${st.light}`} title={st.title}>● {st.label}</span>}</div>
      <div className="form">
        <Field label="检测方式">
          <Seg<HealthMode> value={mode} onChange={setMode} options={[{ value: 'none', label: '不检测' }, { value: 'ping', label: 'Ping' }, { value: 'udp', label: 'UDP 探测' }]} />
          <div className="hint">
            {mode === 'none' && '不主动检测。动作如果开了回包校验，也会从中判断设备是否在线。'}
            {mode === 'ping' && <>调系统 ping。<b>只说明网络层通不通</b>：设备程序死了可能仍能 ping 通，设备屏蔽 ICMP 则会误报离线。</>}
            {mode === 'udp' && '发一条只读的状态查询并校验回包，最准；设备必须会回。'}
          </div>
        </Field>
        {h && (
          <Field
            label="检测间隔"
            hint={`每台设备单独设置，多久检测一次。连续失败 3 次判定离线并记告警，按当前间隔约 ${offlineDelayLabel(h.intervalSec ?? 30)} 后发现。间隔越短发现越快，但网络流量也越多。`}
          >
            <IntervalPicker value={h.intervalSec ?? 30} onChange={(sec) => set((c) => (c.intervalSec = sec))} />
          </Field>
        )}
        {h?.mode === 'udp' && (
          <Field label="探测指令" hint={probeCmds.length === 0 ? <span className="err">指令库里还没有开了回包校验的指令。请先在「指令」页签里添加一条只读的状态查询，并开启回包校验。</span> : '请选择只读的状态查询（不会改变设备状态的那种）。软件不会替你自动选。'}>
            <select className={h.probe?.commandId ? '' : 'bad'} value={h.probe?.commandId ?? ''} onChange={(e) => set((c) => (c.probe = e.target.value ? { commandId: e.target.value } : undefined))}>
              <option value="">选择指令…</option>
              {probeCmds.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        {h && (
          <Field label="">
            <span className="row">
              <button onClick={probe} disabled={busy || (h.mode === 'udp' && !h.probe?.commandId)}>{busy ? '检测中…' : '立即检测一次'}</button>
              <button title="把这台设备的检测设置应用到其他设备" onClick={() => openBatchHealth(h)}>应用到其他设备…</button>
              {res && <span className={`hint ${res.ok ? 'okc' : 'err'}`}>{res.ok ? '✓ ' : '✗ '}{res.text}</span>}
            </span>
          </Field>
        )}
      </div>
    </>
  );
}


// ───────────── 操作面板 ─────────────

function PadInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project)!;
  const pad = (project.pads ?? []).find((p) => p.id === id)!;
  const patch = (fn: (p: Pad) => void) => edit((x) => { const p = x.pads?.find((q) => q.id === id); if (p) fn(p); });
  return (
    <>
      <div className="form">
        <Field label="名称"><input value={pad.name} onChange={(e) => patch((p) => (p.name = e.target.value))} /></Field>
        <Field label="每行几个" hint="1~8，按钮会按这个列数排成网格；大按钮占 2 列"><NumInput value={pad.columns ?? 4} min={1} max={8} width={60} onChange={(v) => patch((p) => (p.columns = v ?? 4))} /></Field>
      </div>
      <div className="hint pad">点面板里的按钮，在这里修改它的绑定。面板上点「＋ 按钮」「＋ 开关」添加。</div>
      <div className="foot">
        <button className="danger" onClick={() => {
          if (!window.confirm(`删除面板「${pad.name}」及其 ${pad.tiles.length} 个按钮？`)) return;
          edit((p) => (p.pads = (p.pads ?? []).filter((q) => q.id !== id)));
          setPadId(null);
          select(null);
        }}>删除面板</button>
      </div>
    </>
  );
}

function SliderFields({ tile, patch }: { tile: PadTile; patch: (fn: (t: PadTile) => PadTile | void) => void }) {
  const { min, max, step, initial } = sliderRange(tile);
  const n = sliderSteps(tile);
  return (
    <>
      <Field label="范围" hint="操作员看到的范围。未启用数值映射时，也直接作为设备发送值。">
        <span className="row" style={{ gap: 6 }}>
          最小 <NumInput value={min} min={-1e9} width={64} onChange={(v) => patch((t) => { t.min = v ?? 0; })} />
          最大 <NumInput value={max} min={-1e9} width={64} onChange={(v) => patch((t) => { t.max = v ?? 100; })} />
          步长 <NumInput value={step} min={1e-6} width={56} onChange={(v) => patch((t) => { t.step = v ?? 1; })} />
        </span>
      </Field>
      <Field label="单位"><input value={tile.unit ?? ''} placeholder="如 %、dB（可选）" maxLength={16} onChange={(e) => patch((t) => { t.unit = e.target.value || undefined; })} /></Field>
      <Field label="数值映射" hint="把界面范围线性转换成设备范围，精度0为四舍五入取整。"><Check checked={!!tile.mapping} label="转换成设备值" onChange={(v) => patch((t) => { t.mapping = v ? { min: 0, max: 255, precision: 0 } : undefined; })} /></Field>
      {tile.mapping && <Field label="设备范围"><span className="row">起点 <NumInput value={tile.mapping.min} min={-1e9} max={1e9} onChange={(v) => patch((t) => { t.mapping!.min = v ?? 0; })} /> 终点 <NumInput value={tile.mapping.max} min={-1e9} max={1e9} onChange={(v) => patch((t) => { t.mapping!.max = v ?? 255; })} /> 小数位 <NumInput value={tile.mapping.precision ?? 0} min={0} max={6} width={40} onChange={(v) => patch((t) => { t.mapping!.precision = v ?? 0; })} /></span><div className="hint">预览：{min}{tile.unit} → {sliderOutput(tile, min)}；{max}{tile.unit} → {sliderOutput(tile, max)}</div></Field>}
      <Field label="初始位置" hint={`界面首次显示的位置，不会发送。共 ${n + 1} 档。`}>
        <NumInput value={initial} min={-1e9} width={64} onChange={(v) => patch((t) => { t.initial = v; })} allowEmpty />
      </Field>
    </>
  );
}

function PadTileInspector({ padId, tileId }: { padId: string; tileId: string }) {
  const project = useStore((s) => s.project)!;
  const draftPending = useStore((s) => s.saveState !== 'saved');
  const pad = project.pads!.find((p) => p.id === padId)!;
  const tile = pad.tiles.find((t) => t.id === tileId)!;
  const patch = (fn: (t: PadTile) => PadTile | void) =>
    edit((p) => {
      const x = p.pads?.find((q) => q.id === padId);
      const i = x?.tiles.findIndex((t) => t.id === tileId) ?? -1;
      if (!x || i < 0) return;
      const r = fn(x.tiles[i]!);
      if (r) x.tiles[i] = r;
    });
  const [res, setRes] = useState<{ text: string; bad: boolean } | null>(null);

  const tryIt = async () => {
    setRes({ text: '执行中…', bad: false });
    try {
      const r = await rpc<{ actions: number; ignored?: boolean }>('runPadTile', { padId, tileId, ...(tile.kind === 'slider' ? { value: sliderRange(tile).initial } : {}) });
      setRes({ text: r.ignored ? '点得太快了，已忽略' : `已启动（${r.actions} 个执行点），进度见运行总览，结果见日志`, bad: false });
    } catch (e) {
      setRes({ text: e instanceof RpcFailure ? e.message : String(e), bad: true });
    }
  };

  return (
    <>
      <div className="form">
        <Field label="名称"><input value={tile.label} onChange={(e) => patch((t) => { t.label = e.target.value; })} /></Field>
        <Field label="类型" hint={tile.kind === 'toggle' ? '开关：点一下在「开」和「关」之间切换，各绑一组动作。亮灯状态是软件推测的，不代表设备真实状态。' : tile.kind === 'slider' ? '滑块：拖动选一个范围内的值（如调光 0~255），把值代入下面动作里的 {{value}} 或 {{hex}} 再发送。' : '按钮：点一下执行绑定的动作。'}>
          <Seg<PadTile['kind']> value={tile.kind} onChange={(k) => patch((t) => changeKind(t, k))} options={[{ value: 'button', label: '按钮' }, { value: 'toggle', label: '开关' }, { value: 'slider', label: '滑块' }]} />
        </Field>
        <Field label="颜色">
          <div className="swatches">
            {GROUP_COLORS.map((c) => <span key={c} className={`sw ${tile.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => patch((t) => { t.color = c; })} />)}
          </div>
        </Field>
        <Field label="大小"><Seg<'1' | '2'> value={String(tile.size ?? 1) as '1' | '2'} onChange={(v) => patch((t) => { t.size = Number(v) as 1 | 2; })} options={[{ value: '1', label: '1 列' }, { value: '2', label: '2 列（大按钮）' }]} /></Field>
        {tile.kind === 'button' && (
          <Field label="单选组" hint="同组按钮点哪个哪个亮、其余熄灭，适合互斥的灯光场景。留空 = 不亮灯。">
            <input list={`groups-${padId}`} value={tile.group ?? ''} placeholder="（可选）如：灯光场景" onChange={(e) => patch((t) => { t.group = e.target.value || undefined; })} />
            <datalist id={`groups-${padId}`}>{groupNames(pad).map((g) => <option key={g} value={g} />)}</datalist>
          </Field>
        )}
        {tile.kind === 'slider' && <SliderFields tile={tile} patch={patch} />}
        <Field label="手动接管" hint="操作时接管全部目标设备，期间自动动作跳过；到期后不补发。空值保持自动与手动并行。"><NumInput value={tile.takeoverSec} min={1} max={86400} width={80} allowEmpty onChange={(v) => patch((t) => { t.takeoverSec = v; })} /> 秒</Field>
        {tile.kind !== 'slider' && <Field label="确认"><Check checked={tile.confirm === true} onChange={(v) => patch((t) => { t.confirm = v || undefined; })} label="点击前先让操作员确认（适合「全关」这类）" /></Field>}
      </div>

      <div className="sech">{tile.kind === 'toggle' ? '切到「开」时执行' : tile.kind === 'slider' ? '每次取值时发送' : '点击时执行'} <span>{tile.actions.length}</span></div>
      {tile.kind === 'slider' && <div className="hint" style={{ marginBottom: 6 }}>在「自定义 UDP」的内容里写 <code>{'{{value}}'}</code>（十进制，如 128），HEX 内容写 <code>{'{{hex}}'}</code>（自动补成整字节，如 80）；用「指令」时，把指令参数的值填成 <code>{'{{value}}'}</code> 或 <code>{'{{hex}}'}</code>。预览按最小值显示。</div>}
      <ActionList actions={tile.actions} sliderSample={tile.kind === 'slider' ? sliderOutput(tile, sliderRange(tile).min) : undefined} onChange={(next) => patch((t) => { t.actions = next; })} />
      {tile.kind === 'toggle' && (
        <>
          <div className="sech" style={{ marginTop: 12 }}>切到「关」时执行 <span>{(tile.offActions ?? []).length}</span></div>
          <ActionList actions={tile.offActions ?? []} onChange={(next) => patch((t) => { t.offActions = next; })} />
        </>
      )}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="primary" disabled={draftPending} title={draftPending ? '先应用面板草稿后再试按' : undefined} onClick={tryIt}><Icon name="play" size={12} />{tile.kind === 'slider' ? '试发一次（初始位置的值）' : '试按一次'}</button>
        {res && <span className={`hint ${res.bad ? 'err' : 'okc'}`}>{res.text}</span>}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>真的会发出指令；开关会同时切换状态。</div>
      <div className="foot">
        <button title="往前移" onClick={() => edit((p) => { const x = p.pads?.find((q) => q.id === padId); if (x) x.tiles = moveTile(x.tiles, tileId, -1); })}>← 前移</button>
        <button title="往后移" onClick={() => edit((p) => { const x = p.pads?.find((q) => q.id === padId); if (x) x.tiles = moveTile(x.tiles, tileId, 1); })}>后移 →</button>
        <button onClick={() => {
          const nid = genId('tile');
          edit((p) => { const x = p.pads?.find((q) => q.id === padId); const src = x?.tiles.find((t) => t.id === tileId); if (x && src) x.tiles.push(duplicateTile(src, nid, () => genId('a'))); });
          select({ kind: 'padTile', padId, tileId: nid });
        }}>复制</button>
        <button className="danger" onClick={() => {
          if (!window.confirm(`删除按钮「${tile.label}」？`)) return;
          edit((p) => { const x = p.pads?.find((q) => q.id === padId); if (x) x.tiles = x.tiles.filter((t) => t.id !== tileId); });
          select({ kind: 'pad', id: padId });
        }}>删除</button>
      </div>
    </>
  );
}
