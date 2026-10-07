/** 单独检查关键还原选项首屏可见；overflow:auto只能说明可滚动，不能证明首屏可见。 */
export function inspectBundleOptionsFirstScreen() {
  const dialog = document.querySelector<HTMLElement>('.bundle-dialog');
  const body = dialog?.querySelector<HTMLElement>('.mb');
  const footer = dialog?.querySelector<HTMLElement>('.mf');
  if (!body || !footer) return { visible: false, options: [], scrollTop: null };
  const b = body.getBoundingClientRect(), f = footer.getBoundingClientRect();
  const options = [...body.querySelectorAll<HTMLElement>('label.check')].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent?.trim(), top: r.top, bottom: r.bottom,
      visible: el.checkVisibility({ checkVisibilityCSS: true }) && r.width > 0 && r.height > 0 && r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= Math.min(b.bottom, f.top, innerHeight) + 1 };
  });
  return { visible: body.scrollTop === 0 && options.length === 2 && options.every((x) => x.visible), options, scrollTop: body.scrollTop };
}
