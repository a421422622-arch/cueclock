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
