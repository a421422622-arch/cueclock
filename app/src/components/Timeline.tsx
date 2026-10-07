import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import type { Cue, DayKind, Project, Timeline as TimelineModel } from '@engine/types.ts';
import { formatTime, parseTime } from '@engine/time.ts';
import { edit, engineNow, followMode, redo, select, setMode, syncActiveMode, undo, useStore } from '../store.ts';
import type { Selection } from '../store.ts';
import { genId, ruleText } from '../lib/labels.ts';
import { deviceColor, GROUP_COLORS, modeColor } from '../lib/colors.ts';
import { cloneMode, layoutChips, targetTracks } from '../lib/timeline.ts';
import type { TargetMark, TargetTrack } from '../lib/timeline.ts';
import { Check, ColorField, Field } from './fields.tsx';
import { Icon } from './Icon.tsx';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const LABEL_W = 232;
/** 事件点胶囊：宽度、行高、轨道上下留白 */
const CHIP_W = 152;
const MASTER_CHIP_W = 140;
const CHIP_MIN_W = 46;
const LANE_MIN_H = 66;
const MASTER_MIN_H = 74;
const ROW_H = 36;
/** 一条轨道最多显示几行胶囊；更密的折叠成「+N」，点一下放大到那一段 */
const MAX_ROWS = 3;
const PAD_TOP = 9;
const RULER_H = 34;
const TICK_STEPS = [12 * HOUR, 6 * HOUR, 3 * HOUR, HOUR, 1_800_000, 600_000, 300_000, 60_000, 30_000, 10_000, 5_000, 1_000, 500, 100];
const SNAPS = [{ ms: 60_000, label: '1 分钟' }, { ms: 10_000, label: '10 秒' }, { ms: 1_000, label: '1 秒' },
  { ms: 100, label: '100 毫秒' }, { ms: 10, label: '10 毫秒' }, { ms: 1, label: '1 毫秒' }];
const clampMs = (ms: number) => Math.max(0, Math.min(DAY - 1, ms));
const msOfDay = (epoch: number) => {
  const d = new Date(epoch);
  return d.getHours() * HOUR + d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds();
};
/** 事件点胶囊里的时间：整秒不显示 .000，省出位置给「待配置」「×N」等说明 */
const chipTime = (ms: number) => (ms % 1000 === 0 ? formatTime(ms).slice(0, 8) : formatTime(ms));
const tickLabel = (ms: number, step: number) => {
  const t = formatTime(ms);
  return step >= 60_000 ? t.slice(0, 5) : step >= 1000 ? t.slice(0, 8) : t;
};

export function Timeline() {
  const project = useStore((s) => s.project)!;
  const engine = useStore((s) => s.status?.engine ?? null);
  const sel = useStore((s) => s.sel);
  const modeId = useStore((s) => s.modeId);
  const following = useStore((s) => s.followActive);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const [pxh, setPxh] = useState(48);
  const [snap, setSnap] = useState(60_000);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [modeDialog, setModeDialog] = useState(false);
  const [view, setView] = useState({ left: 0, width: 1000 });
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ ms: number; x: number } | null>(null);
  const tl = project.timelines.find((t) => t.id === modeId)
    ?? project.timelines.find((t) => engine?.timelines.some((e) => e.id === t.id && e.active)) ?? project.timelines[0];
  const info = engine?.timelines.find((e) => e.id === tl?.id);
  const color = tl ? modeColor(project, tl.id) : GROUP_COLORS[0]!;
  const group = project.groups.find((g) => g.id === tl?.groupId);
  const tracks = useMemo(() => tl ? targetTracks(project, tl) : [], [project, tl]);
  const filtered = tracks.filter((track) => (!hideEmpty || track.marks.length > 0)
    && `${track.device.name} ${track.device.ip} ${track.device.tag ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const overflow = tracks.reduce((n, t) => n + t.marks.filter((m) => m.atMs >= DAY).length, 0);

  useEffect(() => {
    if (!following) return;
    const active = project.timelines.find((t) => (!tl || t.groupId === tl.groupId) && engine?.timelines.some((e) => e.id === t.id && e.active));
    if (active) syncActiveMode(active.id);
  }, [following, engine, project, tl]);

  const syncView = () => {
    const el = scroller.current;
    if (el) setView({ left: el.scrollLeft, width: Math.max(0, el.clientWidth - LABEL_W) });
  };
  useLayoutEffect(() => {
    syncView();
    const el = scroller.current;
    if (el) setPxh(Math.max(6, (el.clientWidth - LABEL_W - 6) / 24));
    const ro = new ResizeObserver(syncView);
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && anchor.current) {
      el.scrollLeft = Math.max(0, (anchor.current.ms / HOUR) * pxh - anchor.current.x);
      anchor.current = null;
      syncView();
    }
  }, [pxh]);
  const zoomTo = (next: number, anchorX?: number) => {
    const el = scroller.current;
    if (el) {
      const x = anchorX ?? (el.clientWidth - LABEL_W) / 2;
      anchor.current = { ms: ((el.scrollLeft + x) / pxh) * HOUR, x };
    }
    setPxh(Math.max(6, Math.min(60_000, next)));
  };
  const goTo = (ms: number) => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (ms / HOUR) * pxh - (el.clientWidth - LABEL_W) / 2);
  };
  useEffect(() => {
    if (sel?.kind !== 'cue' || sel.timelineId !== tl?.id) return;
    const cue = tl.cues.find((c) => c.id === sel.cueId);
    const at = cue ? parseTime(cue.time) : null;
    if (at !== null) goTo(at);
    // 只在选择变化时定位，拖动期间维持滚动位置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const step = TICK_STEPS.findLast((s) => (s / HOUR) * pxh >= 72) ?? TICK_STEPS[0]!;
  const W = 24 * pxh;
  const ticks = useMemo(() => {
    const from = Math.max(0, Math.floor(((view.left / pxh) * HOUR) / step) * step);
    const to = Math.min(DAY, ((view.left + view.width) / pxh) * HOUR + step);
    const out: number[] = [];
    for (let t = from; t <= to; t += step) out.push(t);
    // 一天的终点标签（24:00）靠左对齐不了，若和前一个刻度标签挤在一起就不画（"21:0024:00" 重叠）
    const last = out.at(-1);
    if (last === DAY && out.length > 1 && ((last - out[out.length - 2]!) / HOUR) * pxh < 64) out.pop();
    return out;
  }, [view, pxh, step]);

  const addCue = (e: MouseEvent<HTMLDivElement>, target?: string) => {
    if (!tl || (e.target as HTMLElement).closest('.cue, .cue-more')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = clampMs(Math.round((((e.clientX - rect.left) / pxh) * HOUR) / snap) * snap);
    const id = genId('c');
    const device = project.devices.find((d) => d.id === target);
    edit((p) => p.timelines.find((t) => t.id === tl.id)!.cues.push({ id,
      name: device ? `${device.name} · 新事件` : '新事件点', time: formatTime(ms), enabled: false, defaultTarget: target, actions: [] }));
    select({ kind: 'cue', timelineId: tl.id, cueId: id });
  };
  const copy = () => {
    if (!tl) return;
    const id = genId('t');
    edit((p) => p.timelines.push(cloneMode(tl, id, genId)));
    setMode(id);
  };
  const bootstrap = () => {
    const g = genId('g');
    const ids = [genId('t'), genId('t'), genId('t')];
    edit((p) => {
      p.groups.push({ id: g, name: '日程模式', mode: 'exclusive' });
      const kinds: DayKind[][] = [['workday', 'makeupWorkday'], ['weekend'], ['holiday']];
      ['工作日模式', '周末模式', '节假日模式'].forEach((name, i) => p.timelines.push({ id: ids[i]!, name, groupId: g,
        color: GROUP_COLORS[i], priority: 30 - i * 10, rule: { dayKinds: kinds[i] }, cues: [] }));
    });
    followMode();
  };
  const mainMarks: TargetMark[] = tl?.cues.map((cue) => ({ key: cue.id, cue, atMs: parseTime(cue.time) ?? 0, relMs: 0,
    label: `${cue.actions.length} 个动作`, disabled: cue.enabled === false, pending: cue.actions.length === 0, repeat: 1 })) ?? [];
  const mainLayout = layoutChips(mainMarks, pxh, MASTER_CHIP_W, 6, CHIP_MIN_W);
  const mainShown = mainLayout.filter((m) => m.row < MAX_ROWS);
  const masterHeight = Math.max(MASTER_MIN_H, (Math.max(0, ...mainShown.map((m) => m.row)) + 1) * ROW_H + PAD_TOP * 2);
  /** 放大到某个时刻附近（点「+N」时用）：以该时刻为中心放大 6 倍 */
  const focusAt = (ms: number) => {
    const el = scroller.current;
    if (el) anchor.current = { ms, x: (el.clientWidth - LABEL_W) / 2 };
    setPxh(Math.min(60_000, pxh * 6));
  };

  return <div className="main" style={{ '--mode-color': color } as CSSProperties}>
    <div className="modebar">
      <div className="mode-tabs" role="tablist" aria-label="日程模式">
        {project.timelines.map((mode) => {
          const active = engine?.timelines.find((e) => e.id === mode.id)?.active;
          const g = project.groups.find((x) => x.id === mode.groupId);
          return <button key={mode.id} role="tab" aria-selected={tl?.id === mode.id} data-mode-id={mode.id}
            className={`mode-tab ${tl?.id === mode.id ? 'on' : ''}`} style={{ '--tab-color': modeColor(project, mode.id) } as CSSProperties}
            title={`${g?.name ?? '未分组'} · ${mode.cues.length} 个事件点`}
            onClick={() => setMode(mode.id)}>
            <span className="mode-tab-title"><i />{mode.name}<span className={`mode-status ${active ? 'active' : ''}`}>{mode.enabled === false ? '已禁用' : active ? '今日生效' : '待命'}</span></span>
            <span className="mode-tab-meta">{g?.name ?? '未分组'} · {mode.cues.length} 个事件</span>
          </button>;
        })}
        {!project.timelines.length && <div className="empty">还没有模式。新建模式，或使用下面的常用日程模板。</div>}
      </div>
      <div className="mode-actions">
          <button className="primary" onClick={() => setModeDialog(true)}><Icon name="plus" size={14} />模式</button>
          <button onClick={copy} disabled={!tl} title="复制当前模式（副本默认禁用）"><Icon name="copy" size={14} />复制</button>
          <button title="新建模式组" onClick={() => {
            const id = genId('g');
            edit((p) => p.groups.push({ id, name: '新模式组', mode: 'exclusive' }));
            select({ kind: 'group', id });
          }}><Icon name="plus" size={14} />模式组</button>
      </div>
    </div>
    <div className="toolbar timeline-toolbar">
      <div className="tbgroup">
        <button className="ico" disabled={!canUndo} onClick={undo} title="撤销编辑（Ctrl / Cmd+Z）"><Icon name="undo" size={15} /></button>
        <button className="ico" disabled={!canRedo} onClick={redo} title="重做编辑（Ctrl / Cmd+Shift+Z）"><Icon name="redo" size={15} /></button>
      </div>
      <span className="sep" />
      <div className="tbgroup zoomgroup">
        <button className="ico" onClick={() => zoomTo(pxh * 0.8)} title="缩小"><Icon name="minus" size={14} /></button>
        <input aria-label="时间轴缩放" type="range" min={0} max={100}
          value={Math.round((Math.log(pxh / 6) / Math.log(10_000)) * 100)} onChange={(e) => zoomTo(6 * Math.pow(10_000, Number(e.target.value) / 100))} />
        <button className="ico" onClick={() => zoomTo(pxh * 1.25)} title="放大"><Icon name="plus" size={14} /></button>
        <button onClick={() => zoomTo(Math.max(6, ((scroller.current?.clientWidth ?? 1200) - LABEL_W - 6) / 24))} title="缩放到一整天"><Icon name="fit" size={14} />一整天</button>
        <button onClick={() => goTo(msOfDay(engineNow()))} title="滚动到当前时间"><Icon name="locate" size={14} />现在</button>
      </div>
      <span className="sep" />
      <div className="mode-context">
        <span className="mode-current"><i style={{ background: color }} /><b>{tl?.name ?? '开始安排日程'}</b></span>
        <span className="hint">{tl ? ruleText(tl.rule) : '工作日、周末、节假日按日期自动切换'}</span>
        {tl && <span className={`mode-status ${info?.active && !info.runtimeDisabled ? 'active' : ''}`}>{info?.runtimeDisabled ? '临时禁用' : info?.active ? '实际运行' : '查看 / 编辑'}</span>}
        {group && <button className="ico" onClick={() => select({ kind: 'group', id: group.id })} title="编辑模式组">{group.name} · {group.mode === 'exclusive' ? '互斥' : '并行'}</button>}
      </div>
      <span className="grow" />
      <div className="tbgroup target-tools">
        <label className="searchbox"><Icon name="search" size={14} /><input aria-label="筛选目标" placeholder="筛选目标…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <Check checked={hideEmpty} onChange={setHideEmpty} label="隐藏空轨" />
        <label className="tb">吸附<select aria-label="拖动吸附" value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
          {SNAPS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
        </select></label>
        <button className={`follow-button ${following ? 'on' : ''}`} aria-pressed={following} onClick={followMode} title="时间轴始终显示今天实际生效的模式（查看，不改变调度）"><Icon name="link" size={14} />跟随今日</button>
      </div>
    </div>
    <div className="tl" ref={scroller} onScroll={syncView} onWheel={(e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomTo(pxh * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - scroller.current!.getBoundingClientRect().left - LABEL_W);
    }}>
      <div className="tlinner" style={{ width: LABEL_W + W, '--step': `${step / HOUR * pxh}px` } as CSSProperties}>
        <div className="ruler"><div className="corner" style={{ width: LABEL_W }}><span>目标</span><span className="dim">{tl ? `${tracks.length} 个` : ''}</span></div>
          <div className="rtrack" style={{ width: W }}>{ticks.map((t) => <div key={t} className={`tk ${t === DAY ? 'end' : ''}`} style={{ left: (t / HOUR) * pxh }}>{tickLabel(t, step)}</div>)}</div>
        </div>
        {tl ? <>
          <div className="trow mode-master" data-master-mode={tl.id} style={{ position: masterHeight > 160 ? 'relative' : 'sticky' }}>
            <div className="hcell master-label" style={{ width: LABEL_W, height: masterHeight }}>
              <div className="n"><button className="ico caret" aria-label={expanded ? '收起目标时间轴' : '展开目标时间轴'} onClick={() => setExpanded(!expanded)}><Icon name="chevron" size={14} style={{ transform: expanded ? undefined : 'rotate(-90deg)' }} /></button>
                <span className="name" onClick={() => select({ kind: 'timeline', id: tl.id })}>{tl.name}</span><span className="tag">{tl.cues.length}</span>
                <button className="ico master-edit" title="编辑模式名称、颜色、规则" onClick={() => select({ kind: 'timeline', id: tl.id })}><Icon name="edit" size={13} /></button></div>
              <div className="rule">主时间轴 · 全部目标的事件点</div>
            </div>
            <div className="track master-track" style={{ width: W, height: masterHeight }} onDoubleClick={(e) => addCue(e)}>
              {mainShown.map(({ mark, row, flip, w }) => <CueMark key={mark.key} tl={tl} mark={mark} color={color} pxh={pxh} snap={snap} row={row} flip={flip} w={w} sel={sel} master />)}
              <MoreBadges layout={mainLayout} onFocus={focusAt} />
              {!tl.cues.length && <span className="track-empty">双击主时间轴新建多目标事件，或双击下面的目标小时间轴</span>}
            </div>
          </div>
          {expanded && filtered.map((track) => <TrackRow key={track.device.id} track={track} tl={tl} project={project}
            color={deviceColor(project, track.device.id)} pxh={pxh} snap={snap} W={W} stepPx={step / HOUR * pxh} sel={sel}
            onAdd={(e) => addCue(e, track.device.id)} onFocus={focusAt} />)}
          {expanded && filtered.length === 0 && <div className="empty big">{project.devices.length ? '没有匹配的目标，调整筛选或关闭「隐藏空轨」。' : '先在左侧添加设备，每个设备会自动出现一条目标小时间轴。'}</div>}
          <Playhead pxh={pxh} width={W} />
        </> : <div className="timeline-welcome"><b>一个模式，管理所有目标的日程</b><p>主时间轴汇总事件；目标小时间轴按设备展示。同组模式根据日期自动切换。</p>
          <button className="primary" onClick={bootstrap}>创建工作日 / 周末 / 节假日模式</button><button onClick={() => setModeDialog(true)}>从空模式开始</button></div>}
      </div>
    </div>
    <div className="timeline-footer"><span>{overflow ? <span className="err">{overflow} 个目标动作超出当天，已标红；运行时会跳过</span> : '双击新建 · 拖动整体移动事件 · Ctrl / Cmd+滚轮缩放'}</span>
      <span>{tl ? `24 小时 · ${tracks.reduce((n, t) => n + t.marks.length, 0)} 个目标动作标记` : ''}</span></div>
    {modeDialog && <ModeDialog project={project} onClose={() => setModeDialog(false)} />}
  </div>;
}

function Playhead({ pxh, width }: { pxh: number; width: number }) {
  const [now, setNow] = useState(() => msOfDay(engineNow()));
  useEffect(() => { const t = setInterval(() => setNow(msOfDay(engineNow())), 200); return () => clearInterval(t); }, []);
  const x = (now / HOUR) * pxh;
  return <>
    <div className="past" style={{ left: LABEL_W, width: Math.min(width, x), top: RULER_H }} />
    <div className="playhead" style={{ left: LABEL_W + x }}><span className="now-pill">{formatTime(now).slice(0, 8)}</span></div>
  </>;
}

function TrackRow({ track, tl, project, color, pxh, snap, W, sel, onAdd, onFocus }: {
  track: TargetTrack; tl: TimelineModel; project: Project; color: string; pxh: number; snap: number; W: number; stepPx?: number;
  sel: Selection; onAdd: (e: MouseEvent<HTMLDivElement>) => void; onFocus: (ms: number) => void;
}) {
  const { device, marks } = track;
  const layout = layoutChips(marks, pxh, CHIP_W, 6, CHIP_MIN_W);
  const shown = layout.filter((m) => m.row < MAX_ROWS);
  const height = Math.max(LANE_MIN_H, (Math.max(0, ...shown.map((m) => m.row)) + 1) * ROW_H + PAD_TOP * 2);
  const selected = sel?.kind === 'device' && sel.id === device.id;
  return <div className={`trow target-row ${device.enabled === false ? 'dis' : ''} ${selected ? 'rowsel' : ''}`} data-target-id={device.id} style={{ '--target-color': color } as CSSProperties}>
    <div className={`hcell ${selected ? 'sel' : ''}`} style={{ width: LABEL_W, height }} onClick={() => select({ kind: 'device', id: device.id })}>
      <div className="n"><input type="color" className="track-color" aria-label={`${device.name} 轨道颜色`} title="设置这个目标的颜色"
        value={deviceColor(project, device.id)} onClick={(e) => e.stopPropagation()}
        onChange={(e) => edit((p) => { p.devices.find((d) => d.id === device.id)!.color = e.target.value; })} />
        <span className="name">{device.name}</span><span className="tag">{marks.length}</span></div>
      <div className="rule mono">{device.ip}{device.port ? `:${device.port}` : ''}{device.tag ? ` · ${device.tag}` : ''}{device.enabled === false ? ' · 已禁用' : ''}</div>
    </div>
    <div className="track target-track" style={{ width: W, height }} onDoubleClick={onAdd}>
      {shown.map(({ mark, row, flip, w }) => <CueMark key={mark.key} tl={tl} mark={mark} color={color} pxh={pxh} snap={snap} row={row} flip={flip} w={w} sel={sel} />)}
      <MoreBadges layout={layout} onFocus={onFocus} />
      {!marks.length && <span className="track-empty">双击为 {device.name} 新建事件点</span>}
    </div>
  </div>;
}

/** 超出最大行数的事件点：按位置相近分组，折叠成「+N」，点击放大到那一段。 */
function MoreBadges({ layout, onFocus }: { layout: { mark: TargetMark; row: number; left: number; w: number }[]; onFocus: (ms: number) => void }) {
  const hidden = layout.filter((m) => m.row >= MAX_ROWS).sort((a, b) => a.left - b.left);
  const groups: typeof hidden[] = [];
  for (const m of hidden) {
    const g = groups.at(-1);
    if (g && m.left - g[g.length - 1]!.left < 90) g.push(m);
    else groups.push([m]);
  }
  return <>{groups.map((g) => {
    const first = g[0]!;
    const names = g.map((m) => `${formatTime(m.mark.atMs).slice(0, 8)} ${m.mark.cue.name}`).join('\n');
    return <button key={first.mark.key} className="cue-more" style={{ left: first.left, top: PAD_TOP + (MAX_ROWS - 1) * ROW_H + 3 }}
      title={`还有 ${g.length} 个事件点（太密，已折叠）：\n${names}\n点击放大到这一段`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onFocus(first.mark.atMs)}>+{g.length}</button>;
  })}</>;
}

function CueMark({ tl, mark, color, pxh, snap, row, flip, w, sel, master = false }: {
  tl: TimelineModel; mark: TargetMark; color: string; pxh: number; snap: number; row: number; flip: boolean; w: number; sel: Selection; master?: boolean;
}) {
  const { cue } = mark;
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; ms: number; moved: boolean; next: number | null } | null>(null);
  const base = parseTime(cue.time) ?? 0;
  const ms = drag === null ? mark.atMs : drag + mark.relMs;
  const x = clampMs(ms) / HOUR * pxh;
  const selected = sel?.kind === 'cue' && sel.timelineId === tl.id && sel.cueId === cue.id && (master || !sel.actionId || sel.actionId === mark.actionId);
  const choose = () => select({ kind: 'cue', timelineId: tl.id, cueId: cue.id, actionId: mark.actionId });
  const commit = (at: number) => edit((p) => { const c = p.timelines.find((t) => t.id === tl.id)?.cues.find((c) => c.id === cue.id); if (c) c.time = formatTime(clampMs(at)); });
  return <div className={`cue ${master ? 'master-cue' : 'target-cue'} ${selected ? 'sel' : ''} ${mark.disabled ? 'off' : ''} ${mark.pending ? 'pending' : ''} ${ms >= DAY ? 'overflow' : ''} ${flip || clampMs(ms) / HOUR * pxh + w > 24 * pxh ? 'flip' : ''} ${w < 96 ? 'narrow' : ''} ${w < 62 ? 'tiny' : ''}`}
    data-cue-id={cue.id} data-action={mark.actionId} data-time={formatTime(base)} role="button" tabIndex={0}
    aria-label={`${cue.name} ${tickLabel(ms, 1)}${mark.pending ? ' 待配置' : ''}`}
    title={`${cue.name}\n事件时间：${formatTime(base)}\n${master ? mark.label : `首次发送：${formatTime(ms)} · ${mark.label}${mark.repeat > 1 ? ` · 重复 ${mark.repeat} 次` : ''}`}\n拖动会整体移动此事件的全部动作和关联目标${ms >= DAY ? '\n已超出当天，不会执行' : ''}`}
    style={{ left: (clampMs(ms) / HOUR) * pxh, top: PAD_TOP + row * ROW_H, width: w, '--cue-color': color } as CSSProperties}
    onClick={choose} onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); choose(); commit(base + (e.key === 'ArrowLeft' ? -snap : snap) * (e.shiftKey ? 10 : 1)); }
    }} onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, ms: base, moved: false, next: null };
      choose();
    }} onPointerMove={(e) => {
      const s = start.current;
      if (!s) return;
      const dx = e.clientX - s.x;
      if (!s.moved && Math.abs(dx) < 4) return;
      s.moved = true;
      s.next = clampMs(Math.round((s.ms + dx / pxh * HOUR) / snap) * snap);
      setDrag(s.next);
    }} onPointerUp={() => {
      const s = start.current;
      start.current = null;
      if (s?.moved && s.next !== null) commit(s.next);
      setDrag(null);
    }} onPointerCancel={() => { start.current = null; setDrag(null); }}>
    <span className="dm" /><span className="lb"><b>{cue.name}</b><small>{chipTime(ms)}{!master && mark.repeat > 1 ? ` ×${mark.repeat}` : ''}{mark.pending ? ' · 待配置' : ''}</small></span>
  </div>;
}

function ModeDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState('新模式');
  const [preset, setPreset] = useState('every');
  const [groupId, setGroupId] = useState(project.groups[0]?.id ?? '__new');
  const [color, setColor] = useState(GROUP_COLORS[project.timelines.length % GROUP_COLORS.length]!);
  const [enabled, setEnabled] = useState(false);
  const add = () => {
    const id = genId('t');
    const kinds: Record<string, DayKind[]> = { workday: ['workday', 'makeupWorkday'], weekend: ['weekend'], holiday: ['holiday'] };
    edit((p) => {
      let gid: string | undefined = groupId || undefined;
      if (gid === '__new') { gid = genId('g'); p.groups.push({ id: gid, name: '日程模式', mode: 'exclusive' }); }
      p.timelines.push({ id, name: name.trim(), color, groupId: gid, enabled, priority: preset === 'holiday' ? 10 : preset === 'weekend' ? 20 : preset === 'workday' ? 30 : 100,
        rule: kinds[preset] ? { dayKinds: kinds[preset] } : undefined, cues: [] });
    });
    setMode(id);
    onClose();
  };
  return <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="新建日程模式" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <h3>新建日程模式</h3><div className="mb"><div className="form">
        <Field label="模式名称"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="颜色"><ColorField value={color} label="新模式颜色" onChange={setColor} /></Field>
        <Field label="日程模板"><select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="every">每天 / 自定义规则</option><option value="workday">工作日（含调休上班）</option><option value="weekend">普通周末</option><option value="holiday">法定节假日</option>
        </select></Field>
        <Field label="所属组" hint="互斥组按日期和优先级自动选择一个模式；并行组可同时运行多个模式">
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="__new">新建自动切换组</option>
            {project.groups.map((g) => <option key={g.id} value={g.id}>{g.name}（{g.mode === 'exclusive' ? '互斥' : '并行'}）</option>)}<option value="">不分组（独立运行）</option>
          </select></Field>
        <Field label="运行"><Check checked={enabled} onChange={setEnabled} label="创建后参与自动调度" /></Field>
      </div><div className="hint">创建后可以在右侧继续设置星期、指定日期、排除日期和优先级。</div></div>
      <div className="mf"><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={add}>创建模式</button></div>
    </div>
  </div>;
}
