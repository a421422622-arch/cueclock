import { useRef } from 'react';
import type { LayoutKey } from '../lib/layout.ts';
import { commitLayout, resetLayout, setLayoutLive } from '../lib/layoutStore.ts';

/**
 * 分隔条：拖动调整相邻面板的大小；双击恢复这一项的默认值；聚焦后用方向键微调（Shift 步长更大）。
 * measure 根据指针位置和容器矩形算出新尺寸。
 */
export function Splitter({ k, orientation, className, label, measure, step }: {
  k: LayoutKey;
  orientation: 'vertical' | 'horizontal';
  className: string;
  label: string;
  measure: (e: { clientX: number; clientY: number }, rect: DOMRect) => number;
  /** 方向键一步改变多少、及方向：+1 = 向右/向下时尺寸变大 */
  step: 1 | -1;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const parentRect = () => ref.current!.parentElement!.getBoundingClientRect();
  return (
    <div
      ref={ref}
      className={`splitter ${orientation} ${className}`}
      role="separator"
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label={`${label}（拖动调整大小，双击恢复默认）`}
      title={`拖动调整${label}；双击恢复默认`}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => { if (dragging.current) setLayoutLive(k, measure(e, parentRect())); }}
      onPointerUp={() => { if (dragging.current) { dragging.current = false; commitLayout(); } }}
      onPointerCancel={() => { dragging.current = false; commitLayout(); }}
      onDoubleClick={() => resetLayout(k)}
      onKeyDown={(e) => {
        const horizontalKeys = orientation === 'vertical';
        const dir = (horizontalKeys ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 })[e.key as 'ArrowRight'];
        if (dir === undefined) return;
        e.preventDefault();
        const now = currentSize(k, ref.current!);
        setLayoutLive(k, now + dir * step * (e.shiftKey ? 48 : 12));
        commitLayout();
      }}
    />
  );
}

/** 键盘调整时需要当前尺寸：从 CSS 变量读（没调过就读计算后的值）。 */
function currentSize(k: LayoutKey, el: HTMLElement): number {
  const name = { sideW: '--side-w', inspW: '--insp-w', logH: '--log-h', calW: '--cal-w' }[k];
  const v = parseFloat(getComputedStyle(el.parentElement!).getPropertyValue(name));
  return Number.isFinite(v) ? v : 0;
}
