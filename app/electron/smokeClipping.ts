import { inspectBundleOptionsFirstScreen } from './bundleVisibility.ts';
import { inspectPadGeometry } from './padGeometry.ts';
import type { PadGeometryIssue } from './padGeometry.ts';
import type { BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspectTextClipping, assertNoTextClipping, assertClippingCoverage, inspectTopBar } from './textClipping.ts';
import type { TextClipping } from './textClipping.ts';

export async function smokeClipping(win: BrowserWindow, outputDir?: string, breakCss = false) {
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);
  const settle = () => js(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code: string) => {
    for (let i = 0; i < 60; i++) { if (await js<boolean>(code)) return; await pause(100); }
    throw new Error(`自检内容没有加载：${code}`);
  };
  const click = async (selector: string, text?: string) => {
    await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`}); if (!e || e.disabled) throw Error('自检控件不存在或不可用：' + ${JSON.stringify(selector + ' ' + (text ?? ''))}); e.click(); })()`);
    await pause(80); await settle();
  };
  const checks: { name: string; findings: TextClipping[]; geometry: PadGeometryIssue[]; stress: unknown; top: { overflow: boolean; overlap: boolean } }[] = [];
  const scan = () => js<TextClipping[]>(`(${inspectTextClipping.toString()})()`);
  if (outputDir) mkdirSync(outputDir, { recursive: true });
  const capture = async (name: string) => {
    // 数量压力直接作用于现有告警控件；不制造网络故障或发送控制指令。
    const stress = await js(`(() => {
      const alarm = document.querySelector('.alertpill');
      if (!alarm) throw Error('最长状态缺少告警控件');
      const text = [...alarm.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
      if (text) text.textContent = '99999';
      const draft = document.querySelector('.savestate.dirty');
      const paused = document.querySelector('.estop')?.textContent.includes('自动已暂停');
      if (!draft || !paused) throw Error('最长状态缺少草稿或暂停');
      return { draft: !!draft, paused, alerts: alarm.textContent.trim(), projectName: document.querySelector('.projname').value, innerWidth, zoom: window.cueclock.getZoomFactor() };
    })()`);
    await settle();
    const findings = await scan();
    const top = await js<{ overflow: boolean; overlap: boolean }>(`(${inspectTopBar.toString()})()`);
    const geometry = await js<PadGeometryIssue[]>(`(${inspectPadGeometry.toString()})()`);
    checks.push({ name, findings, geometry, stress, top });
    if (outputDir) writeFileSync(path.join(outputDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await click('.viewtabs span', '运行总览');
  // 同一检测器必须能使断言失败；这里真正压坏已渲染的总览卡片。
  await js(`(() => { const s = document.createElement('style'); s.id = 'smoke-broken-css'; s.textContent = '.overview-cards article { height: 8px !important; max-height: 8px !important; padding: 0 !important; overflow: hidden !important; }'; document.head.append(s); })()`);
  await settle();
  const broken = await scan();
  let rejected = false;
  try { assertNoTextClipping([{ name: '故意压坏CSS', findings: broken }]); } catch { rejected = true; }
  if (outputDir) writeFileSync(path.join(outputDir, 'negative-control.png'), (await win.webContents.capturePage()).toPNG());
  if (!breakCss) await js(`document.getElementById('smoke-broken-css').remove()`);
  if (!rejected || !broken.some((x) => x.disposition === 'unexpected' && x.selector.includes('overview-cards'))) throw new Error('负对照失败：压坏CSS后未检测到截断');

  // 省略号不能让被压成零宽的内容列冒充正常摘要。
  await js(`(() => { const s=document.createElement('style');s.id='smoke-zero-column';s.textContent='.ln > .c { width:0 !important;min-width:0 !important;max-width:0 !important;overflow:hidden !important; }';document.head.append(s); })()`);
  await settle();
  const zeroColumn = await scan();
  const zeroColumnRejected = zeroColumn.some((x) => x.selector.endsWith('span.c') && x.axis === 'x' && x.disposition === 'unexpected');
  if (outputDir) {
    writeFileSync(path.join(outputDir, 'negative-log-width.png'), (await win.webContents.capturePage()).toPNG());
    writeFileSync(path.join(outputDir, 'negative-log-width.json'), JSON.stringify({ rejected: zeroColumnRejected, findings: zeroColumn }, null, 2));
  }
  await js(`document.getElementById('smoke-zero-column').remove()`);
  if (!zeroColumnRejected) throw new Error('负对照失败：零宽日志列被省略号白名单掩盖');

  await click('.viewtabs span', '模式与时间轴');
  await js(`(() => { const s = document.createElement('style'); s.id = 'smoke-vertical-css'; s.textContent = '.cue .lb > b { height: 2px !important; overflow: hidden !important; }'; document.head.append(s); })()`);
  await settle();
  const vertical = await scan();
  const verticalRejected = vertical.some((x) => x.selector.includes('.lb') && x.axis === 'y' && x.disposition === 'unexpected');
  if (outputDir) writeFileSync(path.join(outputDir, 'negative-vertical.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.getElementById('smoke-vertical-css').remove()`);
  if (!verticalRejected) throw new Error('负对照失败：胶囊省略号白名单掩盖了垂直裁切');

  // 给检测记录窗口造几条真实记录：设备已禁用，后台不会检测；手动检测只 ping 本机 127.0.0.1。
  for (let i = 0; i < 3; i++) await js(`window.cueclock.rpc('probeNow', { device: { id: 'device', name: 'x', ip: '127.0.0.1', health: { mode: 'ping', intervalSec: 30 } } }).then((r) => { if (!r.ok) throw Error(r.error.message); })`);
  for (const width of [1440, 1100]) {
    win.setSize(width, width === 1440 ? 900 : 700); await pause(900); await settle();
    const shot = (name: string) => capture(`${width}-${name}`);
    await click('.viewtabs span', '运行总览'); await shot('overview');
    await click('.viewtabs span', '模式与时间轴');
    await click('.configuration-switch button', '运行'); await pause(150); await shot('runtime-timeline');
    await click('.mode-master .cue'); await shot('runtime-inspector');
    await click('.configuration-switch button', '编辑'); await shot('timeline');
    await click('.master-label .name'); await shot('inspector-mode');
    await click('button[title="编辑模式组"]'); await shot('inspector-group');
    await click('.mode-master .cue'); await shot('inspector-cue');
    await click('.target-row .hcell'); await shot('inspector-device');
    await click('.viewtabs span', '日历与预览'); await shot('calendar');
    await click('.side .tabs span[title="指令"]');
    for (let i = 0; i < 4; i++) { await click(`.sidebody .dev:nth-of-type(${i + 2})`); await shot(`inspector-command-${i}`); }
    await click('.side .tabs span[title="场景"]'); await click('.sidebody .dev'); await shot('inspector-scene');
    await click('.side .tabs span[title="触发器"]');
    // 触发器只新增到本机草稿，绝不应用或创建真实监听端口。
    if (!await js<boolean>(`!!document.querySelector('.sidebody .dev')`)) await click('button[title="新建触发器"]');
    else await click('.sidebody .dev');
    await shot('inspector-trigger');
    await click('.viewtabs span', '操作面板'); await click('.configuration-switch button', '运行'); await shot('pad-operation');
    if (!await js<boolean>(`(() => {
      const toggle=document.querySelector('.padgrid .padtile.toggle'),slider=document.querySelector('.padgrid .padtile.slider');
      return toggle?.classList.contains('unknown') && toggle.querySelector('.pb')?.textContent==='状态未知'
        && getComputedStyle(toggle).borderStyle==='dashed' && toggle.querySelector('.pf.off')?.textContent.includes('回读不可用')
        && slider?.querySelector('.pv')?.textContent==='？' && slider.querySelector('.pf.off')?.textContent.includes('回读不可用');
    })()`)) throw new Error('面板没有正确显示真实缺失回读的未知状态');
    if (await js<boolean>(`(() => {
      const slider=document.querySelector('.padgrid .padtile.slider'),badge=slider.querySelector('.pf').getBoundingClientRect();
      return [...slider.querySelectorAll('.pr > i')].some(e=>{const r=e.getBoundingClientRect();return badge.left<r.right-1 && badge.right>r.left+1 && badge.top<r.bottom-1 && badge.bottom>r.top+1;});
    })()`)) throw new Error('滑块回读角标覆盖了范围标签');
    await shot('pad-feedback-unknown');
    if (width === 1440) {
      // 压坏已渲染控件，证明几何检查能分别拒绝重叠和越界。
      await js(`(() => { const tile=document.querySelector('.padtile.toggle'),badge=tile.querySelector('.pf');badge.dataset.previousStyle=badge.getAttribute('style')??'';const box=tile.getBoundingClientRect(),title=tile.querySelector('.pl').getBoundingClientRect();badge.style.top=(title.top-box.top+4)+'px';badge.style.bottom='auto'; })()`);
      await settle(); const overlaps = await js<PadGeometryIssue[]>(`(${inspectPadGeometry.toString()})()`);
      const overlapRejected = overlaps.some((x) => x.kind === 'overlap' && (x.first.includes('.pf') || x.second?.includes('.pf')));
      if(outputDir){writeFileSync(path.join(outputDir,'negative-pad-overlap.png'),(await win.webContents.capturePage()).toPNG());writeFileSync(path.join(outputDir,'negative-pad-overlap.json'),JSON.stringify({rejected:overlapRejected,issues:overlaps},null,2));}
      await js(`(() => { const badge=document.querySelector('.padtile.toggle .pf');badge.setAttribute('style',badge.dataset.previousStyle);delete badge.dataset.previousStyle; })()`);
      if(!overlapRejected)throw new Error('负对照失败：按钮角标重叠未检出');
      await js(`document.querySelector('.padtile.slider .pl').style.transform='translateX(500px)'`);
      await settle(); const outside = await js<PadGeometryIssue[]>(`(${inspectPadGeometry.toString()})()`);
      const outsideRejected=outside.some((x)=>x.kind==='outside');
      if(outputDir){writeFileSync(path.join(outputDir,'negative-pad-outside.png'),(await win.webContents.capturePage()).toPNG());writeFileSync(path.join(outputDir,'negative-pad-outside.json'),JSON.stringify({rejected:outsideRejected,issues:outside},null,2));}
      await js(`document.querySelector('.padtile.slider .pl').style.removeProperty('transform')`);
      if(!outsideRejected)throw new Error('负对照失败：按钮内容越界未检出');
    }
    await click('.configuration-switch button', '编辑'); await click('.padtabs > span'); await shot('inspector-pad');
    for (const kind of ['button', 'toggle', 'slider']) { await click(`.padgrid .padtile.${kind}:not(.add)`); await shot(`inspector-pad-${kind}`); }
    await click('.configuration-switch button', '运行');
    await click('.configuration-switch button', '编辑');
    await click('.projbtn'); await shot('configuration-files');
    // 实际导出→修改测试副本→文件控件→真实previewBundle，绝不确认还原或写入网络设置。
    const beforeBundle = await js(`window.cueclock.rpc('getProject').then(r=>{if(!r.ok)throw Error(r.error.message);return {rev:r.result.rev,instanceId:r.result.instanceId};})`);
    const expectedBundle = await js<{ projectName: string; changes: string[]; warnings: string[] }>(`(async () => {
      const r=await window.cueclock.rpc('exportBundle');if(!r.ok)throw Error(r.error.message);const bundle=r.result;
      bundle.project.data.name='东侧展厅跨机器恢复与灯光投影联动配置（备份包长名称验收）';
      bundle.createdBy.engineVersion='99.0.0';bundle.settings.network={localAddresses:['198.51.100.210'],localPort:65533};
      const preview=await window.cueclock.rpc('previewBundle',{bundle});if(!preview.ok)throw Error(preview.error.message);
      const input=document.querySelector('.configuration-dialog input[type=file]');if(!input||input.disabled)throw Error('备份包文件控件不可用');
      const files=new DataTransfer();files.items.add(new File([JSON.stringify(bundle)],'东侧展厅运行配置与诊断数据完整备份包.cueclock-bundle.json',{type:'application/json'}));
      input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));return preview.result;
    })()`);
    await wait(`!!document.querySelector('.bundle-dialog')`);
    if (!expectedBundle.changes.length || !expectedBundle.warnings.length || !await js<boolean>(`document.querySelector('.bundle-dialog').textContent.includes(${JSON.stringify(expectedBundle.projectName)}) && document.querySelector('.bundle-dialog').textContent.includes(${JSON.stringify(expectedBundle.warnings[0])})`)) throw new Error('备份包预览没有显示真实差异和警告');
    await shot('bundle-dialog');
    const bundleOptions = await js<ReturnType<typeof inspectBundleOptionsFirstScreen>>(`(${inspectBundleOptionsFirstScreen.toString()})()`);
    if(outputDir)writeFileSync(path.join(outputDir,`${width}-bundle-first-screen.json`),JSON.stringify(bundleOptions,null,2));
    if(!bundleOptions.visible)throw new Error('备份包还原的两项关键选项首屏不可见：'+JSON.stringify(bundleOptions));
    await click('.bundle-dialog .mf button', '取消');
    const afterBundle = await js(`window.cueclock.rpc('getProject').then(r=>{if(!r.ok)throw Error(r.error.message);return {rev:r.result.rev,instanceId:r.result.instanceId};})`);
    if (JSON.stringify(beforeBundle) !== JSON.stringify(afterBundle)) throw new Error('备份包预览改变了运行配置或重启了引擎');
    await click('#configuration-software-tab'); await pause(250); await shot('configuration-software');
    await click('.configuration-dialog .mf button', '关闭');
    await click('.apply-open'); await pause(200); await shot('apply-dialog'); await click('.apply-dialog .mf button', '返回编辑');
    await click('.viewtabs span', '模式与时间轴'); await click('.mode-actions .primary'); await shot('mode-dialog');
    await click('.modal .mf button', '取消');
    await click('.viewtabs span', '运行总览'); await click('.overview-table button.link', '检测记录'); await pause(1300); await shot('ping-monitor');
    if (!await js<boolean>(`document.querySelectorAll('.ping-list > div').length >= 3 && !!document.querySelector('.ping-chart rect.ok')`)) throw new Error('检测记录窗口没有显示真实记录');
    await click('.ping-monitor .mf button', '关闭');
    await click('.loghead .tabs2 > span', '操作记录');
    await wait(`!!document.querySelector('.auditrow')`); await shot('audit');
    await js(`(() => { const row=[...document.querySelectorAll('.auditrow')].find(e=>e.querySelector('ul'));if(!row)throw Error('没有真实操作变更清单');row.open=true;row.scrollIntoView({block:'nearest'}); })()`);
    await shot('audit-expanded');
    await click('.loghead .tabs2 > span', '日志');
  }
  const result = { passed: false, negativeControl: { rejected, findings: broken, verticalRejected, verticalFindings: vertical, zeroColumnRejected }, checks, error: '' };
  try { assertClippingCoverage(checks.map((x) => x.name)); assertNoTextClipping(checks); if (checks.some((x) => x.geometry.length)) throw new Error('面板子元素重叠或超出：' + JSON.stringify(checks.filter((x) => x.geometry.length).map((x) => ({ name: x.name, issues: x.geometry })))); if (checks.some((x) => x.top.overflow || x.top.overlap)) throw new Error('最长状态顶栏超出或重叠'); result.passed = true; } catch (e) { result.error = (e as Error).message; }
  if (outputDir) writeFileSync(path.join(outputDir, 'clipping.json'), JSON.stringify(result, null, 2));
  return result;
}
