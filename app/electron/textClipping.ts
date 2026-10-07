export interface TextClipping {
  selector: string;
  text: string;
  axis: 'x' | 'y';
  disposition: 'unexpected' | 'ellipsis' | 'scrollable';
  reason?: string;
  client?: number;
  scroll?: number;
  overflow?: string;
}

export const CLIPPING_PAGES = ['overview', 'timeline', 'inspector-mode', 'inspector-group', 'inspector-cue', 'inspector-device', 'calendar',
  'inspector-command-0', 'inspector-command-1', 'inspector-command-2', 'inspector-command-3', 'inspector-scene', 'inspector-trigger',
  'pad-operation', 'inspector-pad', 'inspector-pad-button', 'inspector-pad-toggle', 'inspector-pad-slider',
  'configuration-files', 'configuration-software', 'apply-dialog', 'mode-dialog'];

export function assertClippingCoverage(names: string[]): void {
  const expected = [1440, 1100].flatMap((width) => CLIPPING_PAGES.map((page) => `${width}-${page}`));
  if (names.length !== expected.length || new Set(names).size !== expected.length || expected.some((n) => !names.includes(n))) throw new Error('截断检查页面矩阵缺失或重复');
}

/** 与文字裁切一起测最长状态下的顶栏；不能用默认状态的测量代替。 */
export function inspectTopBar() {
  const top = document.querySelector<HTMLElement>('.top')!;
  const bounds = top.getBoundingClientRect();
  const items = [...top.children].filter((e) => !e.classList.contains('grow') && e.getBoundingClientRect().width > 0);
  const rect = (e: Element) => e.getBoundingClientRect();
  return {
    overflow: top.scrollWidth > top.clientWidth + 2 || items.some((e) => rect(e).right > bounds.right + 2 || rect(e).left < bounds.left - 2),
    overlap: items.some((a, i) => items.slice(i + 1).some((b) => rect(a).right > rect(b).left + 2 && rect(a).left < rect(b).right - 2 && rect(a).top < rect(b).bottom && rect(b).top < rect(a).bottom)),
  };
}

/** 在真实渲染进程执行。保持自包含，主进程以函数源码注入，不向生产页面添加测试入口。 */
export function inspectTextClipping(): TextClipping[] {
  const findings: TextClipping[] = [];
  const dialogs = [...document.querySelectorAll<HTMLElement>('.modal-bg')].filter((e) => e.getClientRects().length);
  const root = dialogs.at(-1) ?? document.body;
  // 只允许指定位置的横向省略号，不放行垂直裁切，也不泛化成所有 b/small。
  const ellipsis = [
    ['.ln:not(.open) > .det', '日志详情：点行展开'],
    ['.tchip', '日历模式：悬停提示'],
    ['.cue .lb > b, .cue .lb > small', '时间轴胶囊：悬停显示全文'],
    ['.hcell .name, .hcell .rule', '轨道摘要：检查器查看详情'],
    ['.dayitem .desc, .hname', '日历摘要'],
    ['.top .next .v, .top .clock .d, .top .nic', '顶栏摘要：总览查看详情'],
    ['.mode-context > .hint', '模式规则摘要：检查器查看详情'],
    ['.mode-tab-name', '模式名称：自身 title 显示全文，状态标签不收缩'],
  ];
  const selector = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && parts.length < 4; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : [...e.classList].map((c) => `.${c}`).join('')));
      if (e.id) break;
    }
    return parts.join(' > ');
  };
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    if (!(el instanceof HTMLElement) || el.matches('input, textarea, select, option, script, style') || !el.textContent?.trim()) continue;
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    if (!rect.width || !rect.height || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    for (const axis of ['x', 'y'] as const) {
      const client = axis === 'x' ? el.clientWidth : el.clientHeight;
      const scroll = axis === 'x' ? el.scrollWidth : el.scrollHeight;
      const overflow = axis === 'x' ? css.overflowX : css.overflowY;
      if (overflow === 'visible' || scroll <= client + 2) continue;
      const allowed = axis === 'x' && css.textOverflow === 'ellipsis' ? ellipsis.find(([query]) => el.matches(query!)) : undefined;
      const disposition = overflow === 'auto' || overflow === 'scroll' ? 'scrollable' : allowed ? 'ellipsis' : 'unexpected';
      findings.push({ selector: selector(el), text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 140), axis, client, scroll, overflow, disposition,
        ...(allowed ? { reason: allowed[1] } : disposition === 'scrollable' ? { reason: '可滚动区域，内容可到达' } : {}) });
    }
  }
  return findings;
}

export function assertNoTextClipping(checks: { name: string; findings: TextClipping[] }[]): void {
  if (!checks.length) throw new Error('没有检查任何页面');
  const bad = checks.flatMap((check) => check.findings.filter((x) => x.disposition === 'unexpected').map((x) => `${check.name}: ${x.selector} [${x.axis}] ${x.text}`));
  if (bad.length) throw new Error(`文字被意外截断：\n${bad.join('\n')}`);
}
