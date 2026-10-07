import { useEffect, useMemo, useRef, useState } from 'react';
import type { Pad, PadTile } from '@engine/types.ts';
import { beginDraft, displayedProject, edit, engineNow, rpc, select, setPadId, toast, useStore, viewingRuntime } from '../store.ts';
import { genId } from '../lib/labels.ts';
import { dragSender, newTile, padColumns, sliderIndex, sliderRange, sliderSteps, sliderValueAt, textOn, tileLive } from '../lib/pad.ts';
import type { TileLive } from '../lib/pad.ts';
import { RpcFailure } from '../transport.ts';
import { Icon } from './Icon.tsx';

type Flash = 'ok' | 'bad';

/**
 * 操作面板：一块按钮网格，现场手动操作。跟随全局「查看正在运行 / 编辑草稿」：
 * 运行视图点按钮就执行（用正在运行的配置）；草稿视图点按钮选中、在右侧检查器里改绑定。
 */
export function PadView() {
  const project = useStore(displayedProject)!;
  const padId = useStore((s) => s.padId);
  const editing = !useStore(viewingRuntime);
  const sel = useStore((s) => s.sel);
  const lit = useStore((s) => s.status?.engine?.pads) ?? NO_STATE;
  const running = useStore((s) => !!s.status?.engine?.running);
  const devices = useStore((s) => s.status?.engine?.devices);
  const pads = project.pads ?? [];
  const pad = pads.find((p) => p.id === padId) ?? pads[0];
  const [flash, setFlash] = useState<Record<string, Flash>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pressedAt = useRef<Record<string, number>>({}); // 本机最近一次按下每个按钮的时间（引擎时钟），用来判断设备回读是不是比这次操作新

  // 当前面板被删除/切换项目后，回到第一个
  useEffect(() => {
    if (pad && pad.id !== padId) setPadId(pad.id);
  }, [pad, padId]);

  const addPad = () => {
    if (!beginDraft()) return;
    const id = genId('pad');
    edit((p) => { (p.pads ??= []).push({ id, name: `面板 ${(p.pads?.length ?? 0) + 1}`, tiles: [] }); });
    setPadId(id);
    select({ kind: 'pad', id });
  };

  const mark = (key: string, f: Flash) => {
    setFlash((cur) => ({ ...cur, [key]: f }));
    setTimeout(() => setFlash((cur) => { const n = { ...cur }; delete n[key]; return n; }), 700);
  };

  const press = async (p: Pad, t: PadTile) => {
    const key = `${p.id}/${t.id}`;
    if (t.confirm && !window.confirm(`确认执行「${t.label}」？`)) return;
    setBusy(key);
    pressedAt.current[key] = engineNow();
    try {
      const r = await rpc<{ persistFailed?: boolean }>('runPadTile', { padId: p.id, tileId: t.id });
      mark(key, 'ok');
      if (r?.persistFailed) toast(`「${t.label}」已执行，但面板状态没能保存到磁盘：重启引擎后亮灭可能不对，请检查磁盘/状态目录`);
    } catch (e) {
      mark(key, 'bad');
      toast(`「${t.label}」执行失败：${e instanceof RpcFailure ? e.message : String(e)}`);
    }
    setBusy(null);
  };

  const addTile = (kind: PadTile['kind']) => {
    if (!pad) return;
    const id = genId('tile');
    edit((p) => { const x = p.pads?.find((q) => q.id === pad.id); if (x) x.tiles.push(newTile(kind, x.tiles, id)); });
    select({ kind: 'padTile', padId: pad.id, tileId: id });
  };

  if (pads.length === 0) {
    return (
      <div className="padview">
        <div className="empty big">
          <div style={{ fontSize: 16, color: 'var(--ink)', marginBottom: 6 }}>还没有操作面板</div>
          面板是一块按钮网格，现场点一下就执行：开馆、闭馆、全关、切场景……按钮可以绑定场景、指令或自定义 UDP。配置上锁后，面板仍然可用。
          <div style={{ marginTop: 14 }}><button className="primary" onClick={addPad}><Icon name="plus" size={14} />新建面板</button></div>
        </div>
      </div>
    );
  }

  const cols = pad ? padColumns(pad) : 4;
  return (
    <div className="padview">
      <div className="padbar">
        <div className="padtabs">
          {pads.map((p) => (
            <span key={p.id} className={p.id === pad?.id ? 'on' : ''} onClick={() => { setPadId(p.id); if (editing) select({ kind: 'pad', id: p.id }); }}>{p.name}</span>
          ))}
          <button className="ico" title="新建面板" onClick={addPad}><Icon name="plus" size={14} /></button>
        </div>
        <span className="grow" />
        {!running && <span className="hint err">引擎未运行，按钮暂时无法执行</span>}
        <button title="亮灯状态是软件记下的「上次按的是什么」，设备被别的方式改过时用它清空" onClick={() => void rpc('resetPadState', { padId: pad?.id }).catch(() => {})}>重置状态</button>
      </div>

      <div className={`hint padmode ${editing ? 'editing' : ''}`}>{editing
        ? <><b>编辑草稿：</b>点按钮选中，在右侧检查器里改绑定；改完「检查并应用」才生效。要操作按钮请切回「查看正在运行」。</>
        : <><b>操作：</b>点按钮立即执行（使用正在运行的配置）。亮灭与数值是最后操作记录，设备真实状态见「运行总览」；暂停自动日程时仍可手动操作。</>}</div>
      {pad && (
        <div className={`padgrid ${editing ? 'editing' : ''}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {pad.tiles.map((t) => {
            const key = `${pad.id}/${t.id}`;
            // 绑了设备状态的按钮以设备回读为准；没绑的沿用「最后操作记录」
            const live = tileLive(t, lit[key], t.feedback ? devices?.find((d) => d.id === t.feedback!.deviceId)?.feedback : undefined, engineNow(), pressedAt.current[key]);
            const on = live.lit;
            const selected = editing && sel?.kind === 'padTile' && sel.padId === pad.id && sel.tileId === t.id;
            const c = t.color ?? '#98989f';
            if (t.kind === 'slider') {
              return (
                <SliderTile
                  key={t.id}
                  padId={pad.id}
                  tile={t}
                  value={live.source === 'device' ? live.value : live.source === 'record' && typeof lit[key] === 'number' ? (lit[key] as number) : undefined}
                  live={t.feedback ? live : undefined}
                  editing={editing}
                  selected={selected}
                  disabled={!editing && !running}
                  flash={flash[key]}
                  onSelect={() => select({ kind: 'padTile', padId: pad.id, tileId: t.id })}
                  onResult={(ok, msg) => { mark(key, ok ? 'ok' : 'bad'); if (msg) toast(msg); }}
                />
              );
            }
            return (
              <button
                key={t.id}
                className={`padtile ${on ? 'lit' : ''} ${live.source === 'unknown' ? 'unknown' : ''} ${live.mismatch ? 'mismatch' : ''} ${selected ? 'selected' : ''} ${flash[key] ?? ''} ${t.kind}`}
                title={live.mismatch ?? (live.source === 'unknown' ? live.why : live.source === 'device' ? `设备回读：${live.text}` : undefined)}
                style={{ ['--c' as string]: c, ['--t' as string]: textOn(c), gridColumn: t.size === 2 ? 'span 2' : undefined }}
                disabled={!editing && !running}
                onClick={() => (editing ? select({ kind: 'padTile', padId: pad.id, tileId: t.id }) : void press(pad, t))}
              >
                <span className="pl">{t.label || '（未命名）'}</span>
                {t.kind === 'toggle' && <span className="pb">{live.source === 'unknown' ? '状态未知' : on ? '开' : '关'}</span>}
                {t.kind === 'button' && (t.feedback ? live.text !== undefined || live.source === 'unknown' : !!t.group) && <span className="pb">{t.feedback ? (live.source === 'unknown' ? '状态未知' : live.text) : t.group}</span>}
                {t.feedback && <LiveBadge live={live} />}
                {t.confirm && <span className="pc" title="点击前需要确认"><Icon name="alert" size={13} /></span>}
                {busy === key && <span className="pbusy">…</span>}
                {editing && t.actions.length === 0 && (t.offActions ?? []).length === 0 && <span className="pe">未绑定</span>}
              </button>
            );
          })}
          {editing && (
            <>
              <button className="padtile add" onClick={() => addTile('button')}><Icon name="plus" size={14} />按钮</button>
              <button className="padtile add" onClick={() => addTile('toggle')}><Icon name="plus" size={14} />开关</button>
              <button className="padtile add" onClick={() => addTile('slider')}><Icon name="plus" size={14} />滑块</button>
            </>
          )}
          {!editing && pad.tiles.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>这个面板还是空的。点右上角「编辑」，添加按钮并绑定场景或指令。</div>}
        </div>
      )}
      {editing && (
        <div className="hint" style={{ padding: '4px 14px' }}>
          编辑模式：点按钮在右侧修改；亮灯状态是软件推测的（设备大多不回报），不代表设备真实状态。
        </div>
      )}
    </div>
  );
}

const NO_STATE: Record<string, boolean | number> = {};

/** 按钮角标：状态来自设备回读（绿点）/ 回读不可用（问号）/ 与最后操作对不上（警告）。 */
function LiveBadge({ live }: { live: TileLive }) {
  if (live.mismatch) return <span className="pf warn" title={live.mismatch}><Icon name="alert" size={12} />与设备不一致</span>;
  if (live.source === 'unknown') return <span className="pf off" title={live.why}>？回读不可用</span>;
  if (live.source === 'device') return <span className="pf on" title={`设备回读：${live.text}`}><i />设备回读</span>;
  return null;
}

/**
 * 滑块（调光等范围值）。拖动时按 ~80ms 节流发送中间值，松手发送最终值；
 * 显示的是引擎记下的「最后发出的值」，没发过时显示初始位置（不会发送）。
 */
function SliderTile({ padId, tile, value, live, editing, selected, disabled, flash, onSelect, onResult }: {
  padId: string;
  tile: PadTile;
  value: number | undefined;
  live?: TileLive;
  editing: boolean;
  selected: boolean;
  disabled: boolean;
  flash: Flash | undefined;
  onSelect: () => void;
  onResult: (ok: boolean, msg?: string) => void;
}) {
  const { min, max, initial } = sliderRange(tile);
  const steps = sliderSteps(tile);
  // 本地显示的值：拖动中、以及松手后到引擎回报之前；null = 显示引擎里的值
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value ?? initial;
  const dragged = useRef<number | null>(null); // 本次拖动最后一个值；null = 没在拖
  // 最新的 padId/tileId/回调放进 ref，让 dragSender 只创建一次
  const latest = useRef({ padId, tileId: tile.id, label: tile.label, onResult, reset: () => setDrag(null) });
  latest.current = { padId, tileId: tile.id, label: tile.label, onResult, reset: () => setDrag(null) };
  // 引擎回报了新值（本机或别处改的）：不在拖动时就以引擎为准
  useEffect(() => { if (dragged.current === null) setDrag(null); }, [value]);
  const sender = useMemo(() => dragSender((v, final) => {
    const { padId: p, tileId, label, onResult: done, reset } = latest.current;
    rpc<{ persistFailed?: boolean }>('runPadTile', { padId: p, tileId, value: v, final })
      .then((r) => { if (final) done(true, r?.persistFailed ? `「${label}」已发送，但数值没能保存到磁盘：重启引擎后显示可能不对，请检查磁盘/状态目录` : undefined); })
      .catch((e) => { if (final) { reset(); done(false, `「${label}」发送失败：${e instanceof RpcFailure ? e.message : String(e)}`); } });
  }), []);

  const c = tile.color ?? '#98989f';
  const finish = () => {
    if (dragged.current === null) return;
    const v = dragged.current;
    dragged.current = null;
    sender.end(v); // 不清本地值：等引擎回报后再切回引擎的值，避免松手瞬间跳回旧值
  };
  return (
    <div
      className={`padtile slider ${selected ? 'selected' : ''} ${flash ?? ''} ${disabled ? 'off' : ''}`}
      style={{ ['--c' as string]: c, ['--t' as string]: textOn(c), gridColumn: tile.size === 2 ? 'span 2' : undefined }}
      onClick={editing ? onSelect : undefined}
    >
      <span className="pl">{tile.label || '（未命名）'}</span>
      <span className="pv">{live?.source === 'unknown' && drag === null ? '？' : shown}{live?.source === 'unknown' && drag === null ? '' : tile.unit ?? ''}</span>
      {live && <LiveBadge live={live} />}
      <input
        type="range"
        min={0}
        max={steps}
        step={1}
        value={sliderIndex(tile, shown)}
        disabled={editing || disabled}
        onChange={(e) => {
          const v = sliderValueAt(tile, Number(e.target.value));
          dragged.current = v;
          setDrag(v);
          sender.move(v);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyUp={finish}
        onBlur={finish}
      />
      <span className="pr"><i>{min}{tile.unit}</i><i>{max}{tile.unit}</i></span>
      {editing && tile.actions.length === 0 && <span className="pe">未绑定</span>}
    </div>
  );
}
