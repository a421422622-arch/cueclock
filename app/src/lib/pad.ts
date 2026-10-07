import type { Pad, PadTile } from '../../../engine/src/types.ts';
import { GROUP_COLORS } from './colors.ts';
import { hexOf, sliderOutput, sliderRange, sliderSteps, sliderValueAt, snapSliderValue } from '../../../engine/src/padvalue.ts';

export { sliderOutput, sliderRange, sliderSteps, sliderValueAt, snapSliderValue };

export const DEFAULT_COLUMNS = 4;

export const padColumns = (pad: Pad): number => Math.min(8, Math.max(1, Math.round(pad.columns ?? DEFAULT_COLUMNS)));

/** 新按钮：名字按已有数量编号，颜色轮换。 */
export function newTile(kind: PadTile['kind'], existing: PadTile[], id: string): PadTile {
  const n = existing.filter((t) => t.kind === kind).length + 1;
  return {
    id,
    label: kind === 'toggle' ? `开关 ${n}` : kind === 'slider' ? `滑块 ${n}` : `按钮 ${n}`,
    color: GROUP_COLORS[existing.length % GROUP_COLORS.length],
    kind,
    actions: [],
    ...(kind === 'toggle' ? { offActions: [] } : {}),
    ...(kind === 'slider' ? { size: 2 as const, min: 0, max: 100, step: 1 } : {}),
  };
}

/** 按钮左右（顺序）移动 delta 位，越界时停在两端。不修改入参。 */
export function moveTile(tiles: PadTile[], id: string, delta: number): PadTile[] {
  const i = tiles.findIndex((t) => t.id === id);
  if (i < 0) return tiles;
  const j = Math.min(tiles.length - 1, Math.max(0, i + delta));
  if (j === i) return tiles;
  const next = [...tiles];
  const [t] = next.splice(i, 1);
  next.splice(j, 0, t!);
  return next;
}

/** 面板里已有的单选组名，给界面做建议。 */
export const groupNames = (pad: Pad): string[] => [...new Set(pad.tiles.map((t) => t.group).filter((g): g is string => !!g))];

/**
 * 切换按钮类型时同步调整字段：
 * 开关需要 offActions；改成按钮则丢掉 offActions（避免留着看不见的动作）；单选组只属于按钮，改成开关时去掉。
 */
export function changeKind(tile: PadTile, kind: PadTile['kind']): PadTile {
  if (tile.kind === kind) return tile;
  // 滑块的范围字段只属于滑块；开关的关动作、单选组也各有归属
  const { offActions: _off, group: _group, min: _min, max: _max, step: _step, initial: _initial, mapping: _mapping, unit: _unit, ...rest } = tile;
  if (kind === 'toggle') return { ...rest, kind, offActions: tile.offActions ?? [] };
  if (kind === 'slider') return { ...rest, kind, size: rest.size ?? 2, min: 0, max: 100, step: 1 };
  return { ...rest, kind, ...(tile.group ? { group: tile.group } : {}) };
}

/** 滑块当前值对应的档位序号（给 <input type=range> 用；停在 max 的尾档也算一档）。 */
export function sliderIndex(t: PadTile, value: number): number {
  const { min, step } = sliderRange(t);
  return Math.min(sliderSteps(t), Math.max(0, Math.round((value - min) / step)));
}

/** 动作预览里用的滑块取值：{{value}} / {{hex}}。{{hex}} 对非整数无意义，退回 00。 */
export function sliderSample(value: number): Record<string, string> {
  let hex = '00';
  try { hex = hexOf(value); } catch { /* 负数/小数：预览用 00 */ }
  return { value: String(value), hex };
}

export interface DragSender {
  /** 拖动中：节流发送（最快每 gap ms 一次），最新值不丢 */
  move(v: number): void;
  /** 松手：取消等待中的值，立刻发送最终值 */
  end(v: number): void;
}

/** 滑块拖动发送：首个值立刻发，之后每 gap ms 最多发一次最新值；松手发 final。时钟与定时器可注入，便于测试。 */
export function dragSender(
  send: (v: number, final: boolean) => void,
  gap = 80,
  now: () => number = Date.now,
  timers: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void } = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
): DragSender {
  let last = -Infinity;
  let pending: number | null = null;
  let timer: unknown = null;
  const cancel = () => { if (timer !== null) timers.clear(timer); timer = null; pending = null; };
  return {
    move(v) {
      const t = now();
      if (t - last >= gap) {
        cancel();
        last = t;
        send(v, false);
        return;
      }
      pending = v;
      if (timer === null) {
        timer = timers.set(() => {
          timer = null;
          if (pending === null) return;
          const p = pending;
          pending = null;
          last = now();
          send(p, false);
        }, gap - (t - last));
      }
    },
    end(v) {
      cancel();
      last = now();
      send(v, true);
    },
  };
}

/** 复制按钮：新 id、新动作 id，名字加「副本」。 */
export function duplicateTile(tile: PadTile, id: string, newActionId: () => string): PadTile {
  const copy = structuredClone(tile);
  copy.id = id;
  copy.label += ' 副本';
  copy.actions = copy.actions.map((a) => ({ ...a, id: newActionId() }));
  if (copy.offActions) copy.offActions = copy.offActions.map((a) => ({ ...a, id: newActionId() }));
  return copy;
}

/** 按钮上字的颜色：背景较亮用深色字，较暗用浅色字，保证看得清。 */
export function textOn(hex: string | undefined): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#f5f5f7';
  const n = parseInt(m[1]!, 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#0a0a0c' : '#f5f5f7';
}

// ───────────── 按钮的「显示状态」：设备真实回读 or 最后操作记录 ─────────────

export interface TileLive {
  /** record = 最后一次操作记录（没绑设备）；device = 设备回读；unknown = 绑定了设备但现在拿不到可用的回读 */
  source: 'record' | 'device' | 'unknown';
  lit: boolean;
  /** 滑块位置（界面单位）。有设备回读时是设备的值换算回来的 */
  value?: number;
  /** 补充文字：设备回读到的原始值 */
  text?: string;
  /** source 为 unknown 时：为什么拿不到 */
  why?: string;
  /** 设备状态与「最后操作记录」对不上时的说明（例如按过「开」，设备却回读为关） */
  mismatch?: string;
}

export interface FeedbackReading { at: number; values: Record<string, string>; stale: boolean }

const norm = (s: string) => s.trim().toLowerCase();

/** 设备回读值（设备单位）→ 滑块位置（界面单位），是 sliderOutput 的反向；超出范围取端点。 */
export function sliderFromDevice(tile: PadTile, deviceValue: number): number {
  const { min, max } = sliderRange(tile);
  let v = deviceValue;
  const m = tile.mapping;
  if (m && m.max !== m.min) v = min + (deviceValue - m.min) / (m.max - m.min) * (max - min);
  return snapSliderValue(tile, Math.min(max, Math.max(min, v))); // 贴合步长显示（128/255 → 50，而不是 50.2）
}

/**
 * 决定一个按钮此刻怎么显示。没绑设备状态 → 沿用「最后操作记录」；绑了 → 以设备回读为准，
 * 回读缺失或过期时如实显示「未知」，不假装知道。
 */
export function tileLive(tile: PadTile, record: boolean | number | undefined, fb: FeedbackReading | undefined, now: number, pressedAt?: number): TileLive {
  const bind = tile.feedback;
  if (!bind) return { source: 'record', lit: record === true, ...(typeof record === 'number' ? { value: record } : {}) };
  if (!fb) return { source: 'unknown', lit: false, why: '设备还没有回读结果（需要定期状态查询：在线检测选「UDP 探测」并配置回读解析）' };
  if (fb.stale) return { source: 'unknown', lit: false, why: `设备回读已过期（${Math.max(0, Math.round((now - fb.at) / 1000))} 秒前的结果）` };
  const raw = fb.values[bind.field];
  if (raw === undefined) return { source: 'unknown', lit: false, why: `回读里没有字段「${bind.field}」` };
  if (tile.kind === 'slider') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { source: 'unknown', lit: false, text: raw, why: `回读值「${raw}」不是数字` };
    return { source: 'device', lit: false, value: sliderFromDevice(tile, n), text: raw };
  }
  const lit = (bind.on ?? []).some((x) => norm(x) === norm(raw));
  // 回读比这次按下更新才有资格说「不一致」：刚按下时设备还没回报，旧回读和新操作对不上是正常的
  const mismatch = tile.kind === 'toggle' && record === true && !lit && (pressedAt === undefined || fb.at > pressedAt) ? `最后一次操作是「开」，但设备回读是「${raw}」` : undefined;
  return { source: 'device', lit, text: raw, ...(mismatch ? { mismatch } : {}) };
}
