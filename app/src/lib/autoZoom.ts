/**
 * 窗口比设计宽度窄时，整个界面按比例缩小（文字、间距、控件一起），而不是只让布局挤压、文字照旧大小导致超出。
 * 只缩小不放大：宽度 ≥ 1600 保持 100%，窗口越窄按比例越小，最小 80%。用 Electron 的页面缩放（webFrame），所以 CSS 里的宽度断点也按缩放后的宽度生效。
 */
export const DESIGN_WIDTH = 1600;
export const MIN_ZOOM = 0.8;
export const AUTO_ZOOM_KEY = 'cueclock.zoom.auto';

/** 物理宽度（CSS 宽度 × 当前缩放）→ 目标缩放。按 5% 一档取整，避免拖动窗口时抖动。 */
export function targetZoom(physicalWidth: number): number {
  if (!Number.isFinite(physicalWidth) || physicalWidth <= 0) return 1;
  const raw = Math.min(1, Math.max(MIN_ZOOM, physicalWidth / DESIGN_WIDTH));
  return Math.round(raw * 20) / 20;
}

export interface ZoomBridge { getZoomFactor(): number; setZoomFactor(f: number): void }

export const isAutoZoom = (storage: Pick<Storage, 'getItem'>): boolean => storage.getItem(AUTO_ZOOM_KEY) !== 'off';

/**
 * 自动缩放控制器。用户用菜单手动缩放后（当前缩放与我们上次设置的不一致），自动缩放让位，直到用户在设置里重新打开。
 * 纯逻辑，窗口宽度、存储、桥接都由调用方传入，便于测试。
 */
export function createAutoZoom(deps: { bridge: ZoomBridge; width: () => number; storage: Pick<Storage, 'getItem' | 'setItem'> }) {
  let lastSet: number | null = null;
  const enabled = () => isAutoZoom(deps.storage);
  const apply = (): void => {
    if (!enabled()) return;
    const cur = deps.bridge.getZoomFactor();
    if (lastSet !== null && Math.abs(cur - lastSet) > 0.011) {
      deps.storage.setItem(AUTO_ZOOM_KEY, 'off'); // 用户手动缩放了：尊重，不再自动改
      return;
    }
    const next = targetZoom(deps.width() * cur);
    if (Math.abs(next - cur) > 0.001) deps.bridge.setZoomFactor(next);
    lastSet = next;
  };
  return {
    apply,
    enabled,
    set(on: boolean): void {
      deps.storage.setItem(AUTO_ZOOM_KEY, on ? 'on' : 'off');
      lastSet = null;
      if (on) apply();
      else deps.bridge.setZoomFactor(1);
    },
  };
}
