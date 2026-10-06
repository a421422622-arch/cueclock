import type { Pad, PadTile } from '../../../engine/src/types.ts';
import { GROUP_COLORS } from './colors.ts';

export const DEFAULT_COLUMNS = 4;

export const padColumns = (pad: Pad): number => Math.min(8, Math.max(1, Math.round(pad.columns ?? DEFAULT_COLUMNS)));

/** 新按钮：名字按已有数量编号，颜色轮换。 */
export function newTile(kind: PadTile['kind'], existing: PadTile[], id: string): PadTile {
  const n = existing.filter((t) => t.kind === kind).length + 1;
  return {
    id,
    label: kind === 'toggle' ? `开关 ${n}` : `按钮 ${n}`,
    color: GROUP_COLORS[existing.length % GROUP_COLORS.length],
    kind,
    actions: [],
    ...(kind === 'toggle' ? { offActions: [] } : {}),
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
  const { offActions: _off, group: _group, ...rest } = tile;
  return kind === 'toggle' ? { ...rest, kind, offActions: tile.offActions ?? [] } : { ...rest, kind, ...(tile.group ? { group: tile.group } : {}) };
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
