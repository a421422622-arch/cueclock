/** 界面布局：各面板的可调尺寸。保存在本机（localStorage），没设置过的用 CSS 里的默认值。 */
export interface Layout {
  /** 左侧栏宽度 */
  sideW: number;
  /** 右侧检查器宽度 */
  inspW: number;
  /** 底部日志高度 */
  logH: number;
  /** 日历页右侧详情宽度 */
  calW: number;
}

export type LayoutKey = keyof Layout;

export const DEFAULT_LAYOUT: Layout = { sideW: 250, inspW: 370, logH: 180, calW: 340 };

/** 每个面板的最小值；最大值随窗口大小变（保证中间区域至少留 360px 宽、顶部区域至少 200px 高）。 */
export const MIN_SIZE: Layout = { sideW: 160, inspW: 240, logH: 80, calW: 240 };
const STORAGE_KEY = 'cueclock.layout.v1';

export interface Viewport { w: number; h: number }

export function maxSize(key: LayoutKey, other: Layout, vp: Viewport): number {
  switch (key) {
    case 'sideW': return Math.max(MIN_SIZE.sideW, vp.w - other.inspW - 360);
    case 'inspW': return Math.max(MIN_SIZE.inspW, vp.w - other.sideW - 360);
    case 'logH': return Math.max(MIN_SIZE.logH, vp.h - 54 - 200);
    case 'calW': return Math.max(MIN_SIZE.calW, vp.w - other.sideW - other.inspW - 300);
  }
}

/** 把某一项限制在合法范围内（非数字当作无效，返回 null 表示「用默认」）。 */
export function clampOne(key: LayoutKey, value: number, current: Partial<Layout>, vp: Viewport): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const other = { ...DEFAULT_LAYOUT, ...current };
  return Math.round(Math.min(maxSize(key, other, vp), Math.max(MIN_SIZE[key], value)));
}

/** 读出保存的布局：只保留合法的项，其余走默认。坏数据（非 JSON、非对象、类型不对）一律忽略。 */
export function parseLayout(raw: string | null): Partial<Layout> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
    const out: Partial<Layout> = {};
    for (const k of Object.keys(DEFAULT_LAYOUT) as LayoutKey[]) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_SIZE[k] && v <= 4000) out[k] = Math.round(v);
    }
    return out;
  } catch {
    return {};
  }
}

export const layoutStorageKey = STORAGE_KEY;
