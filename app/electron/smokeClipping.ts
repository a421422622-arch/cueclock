import type { BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspectTextClipping, assertNoTextClipping, assertClippingCoverage, inspectTopBar } from './textClipping.ts';
import type { TextClipping } from './textClipping.ts';

export async function smokeClipping(win: BrowserWindow, outputDir?: string, breakCss = false) {
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);
  const settle = () => js(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const click = async (selector: string, text?: string) => {
    await js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`}); if (!e || e.disabled) throw Error('自检控件不存在或不可用：' + ${JSON.stringify(selector + ' ' + (text ?? ''))}); e.click(); })()`);
    await pause(80); await settle();
  };
  const checks: { name: string; findings: TextClipping[]; stress: unknown; top: { overflow: boolean; overlap: boolean } }[] = [];
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
    checks.push({ name, findings, stress, top });
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

  await click('.viewtabs span', '模式与时间轴');
  await js(`(() => { const s = document.createElement('style'); s.id = 'smoke-vertical-css'; s.textContent = '.cue .lb > b { height: 2px !important; overflow: hidden !important; }'; document.head.append(s); })()`);
  await settle();
  const vertical = await scan();
  const verticalRejected = vertical.some((x) => x.selector.includes('.lb') && x.axis === 'y' && x.disposition === 'unexpected');
  if (outputDir) writeFileSync(path.join(outputDir, 'negative-vertical.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.getElementById('smoke-vertical-css').remove()`);
  if (!verticalRejected) throw new Error('负对照失败：胶囊省略号白名单掩盖了垂直裁切');

  for (const width of [1440, 1100]) {
    win.setSize(width, width === 1440 ? 900 : 700); await pause(900); await settle();
    const shot = (name: string) => capture(`${width}-${name}`);
    await click('.viewtabs span', '运行总览'); await shot('overview');
    await click('.viewtabs span', '模式与时间轴');
    await click('.configuration-switch button', '查看正在运行'); await pause(150); await shot('runtime-timeline');
    await click('.mode-master .cue'); await shot('runtime-inspector');
    await click('.configuration-switch button', '编辑草稿'); await shot('timeline');
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
    await click('.viewtabs span', '操作面板'); await click('.padbar .seg span', '操作'); await shot('pad-operation');
    await click('.padbar .seg span', '编辑'); await click('.padtabs > span'); await shot('inspector-pad');
    for (const kind of ['button', 'toggle', 'slider']) { await click(`.padgrid .padtile.${kind}:not(.add)`); await shot(`inspector-pad-${kind}`); }
    await click('.padbar .seg span', '操作');
    await click('.configuration-switch button', '编辑草稿');
    await click('.projbtn'); await shot('configuration-files');
    await click('#configuration-software-tab'); await pause(250); await shot('configuration-software');
    await click('.configuration-dialog .mf button', '关闭');
    await click('.apply-open'); await pause(200); await shot('apply-dialog'); await click('.apply-dialog .mf button', '返回编辑');
    await click('.viewtabs span', '模式与时间轴'); await click('.mode-actions .primary'); await shot('mode-dialog');
    await click('.modal .mf button', '取消');
  }
  const result = { passed: false, negativeControl: { rejected, findings: broken, verticalRejected, verticalFindings: vertical }, checks, error: '' };
  try { assertClippingCoverage(checks.map((x) => x.name)); assertNoTextClipping(checks); if (checks.some((x) => x.top.overflow || x.top.overlap)) throw new Error('最长状态顶栏超出或重叠'); result.passed = true; } catch (e) { result.error = (e as Error).message; }
  if (outputDir) writeFileSync(path.join(outputDir, 'clipping.json'), JSON.stringify(result, null, 2));
  return result;
}
