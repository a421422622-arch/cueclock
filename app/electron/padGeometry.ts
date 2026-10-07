export interface PadGeometryIssue { tile: string; kind: 'overlap' | 'outside'; first: string; second?: string }

/** 在真实DOM测全部可见子元素；祖先/后代的包含以及SVG图标内部绘制不算控件重叠。 */
export function inspectPadGeometry(): PadGeometryIssue[] {
  const out: PadGeometryIssue[] = [];
  for (const tile of document.querySelectorAll<HTMLElement>('.padgrid .padtile:not(.add)')) {
    const bounds = tile.getBoundingClientRect();
    const nodes = [...tile.querySelectorAll<HTMLElement>('*')].filter((el) => el instanceof HTMLElement && el.checkVisibility({ checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const name = tile.querySelector('.pl')?.textContent ?? tile.className;
    // flex子元素可被压窄而文字仍然溢出；元素框之外还测真实文字行框。
    const parts = nodes.flatMap((el) => {
      const pieces = [{ el, rect: el.getBoundingClientRect(), text: false }];
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        const range = document.createRange(); range.selectNodeContents(child);
        for (const rect of range.getClientRects()) if (rect.width && rect.height) pieces.push({ el, rect, text: true });
      }
      return pieces;
    });
    const label = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
    for (const [i, a] of parts.entries()) {
      const r = a.rect;
      if (r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1) out.push({ tile: name, kind: 'outside', first: label(a.el) + (a.text ? '::text' : '') });
      for (const b of parts.slice(i + 1)) {
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const s = b.rect;
        if (r.left < s.right - 1 && r.right > s.left + 1 && r.top < s.bottom - 1 && r.bottom > s.top + 1) out.push({ tile: name, kind: 'overlap', first: label(a.el) + (a.text ? '::text' : ''), second: label(b.el) + (b.text ? '::text' : '') });
      }
    }
  }
  return out;
}
