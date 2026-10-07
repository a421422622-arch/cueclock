import { useSyncExternalStore } from 'react';
import { clampOne, layoutStorageKey, parseLayout } from './layout.ts';
import type { Layout, LayoutKey } from './layout.ts';

/** 用户调整过的尺寸（没调过的项不在里面，界面用 CSS 默认值）。 */
let current: Partial<Layout> = (() => {
  try { return parseLayout(localStorage.getItem(layoutStorageKey)); } catch { return {}; }
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const persist = () => {
  try {
    if (Object.keys(current).length === 0) localStorage.removeItem(layoutStorageKey);
    else localStorage.setItem(layoutStorageKey, JSON.stringify(current));
  } catch { /* 存储不可用：本次会话内仍然生效 */ }
};

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

export const getLayout = (): Partial<Layout> => current;
export const useLayout = (): Partial<Layout> => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current);

/** 拖动中：立刻生效，不写盘（松手时 commitLayout 一次）。 */
export function setLayoutLive(key: LayoutKey, value: number): void {
  const v = clampOne(key, value, current, viewport());
  if (v === null || current[key] === v) return;
  current = { ...current, [key]: v };
  emit();
}
export const commitLayout = (): void => persist();

/** 恢复某一项（双击分隔条）或全部（菜单「恢复默认界面布局」）的默认尺寸。 */
export function resetLayout(key?: LayoutKey): void {
  if (key) { const { [key]: _drop, ...rest } = current; current = rest; } else current = {};
  persist();
  emit();
}

// 窗口缩小后，已保存的尺寸可能超出新窗口能容纳的范围：重新限制（只改显示，不改已保存的值）
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    let changed = false;
    const next: Partial<Layout> = { ...current };
    for (const k of Object.keys(next) as LayoutKey[]) {
      const v = clampOne(k, next[k]!, next, viewport());
      if (v !== null && v !== next[k]) { next[k] = v; changed = true; }
    }
    if (changed) { current = next; emit(); }
  });
}

/** 转成 CSS 变量，放在容器的 style 上；没调过的项不输出，用样式表里的默认值。 */
export function layoutVars(l: Partial<Layout>): Record<string, string> {
  const v: Record<string, string> = {};
  if (l.sideW !== undefined) v['--side-w'] = `${l.sideW}px`;
  if (l.inspW !== undefined) v['--insp-w'] = `${l.inspW}px`;
  if (l.logH !== undefined) v['--log-h'] = `${l.logH}px`;
  if (l.calW !== undefined) v['--cal-w'] = `${l.calW}px`;
  return v;
}
