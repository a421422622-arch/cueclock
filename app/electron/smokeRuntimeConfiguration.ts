import type { BrowserWindow } from 'electron';
import type { Project } from '../../engine/src/types.ts';

/** 只由隔离 smoke-ui 调用：真实窗口、IPC、真实隔离引擎，设备和事件均禁用。 */
export async function smokeRuntimeConfiguration(win: BrowserWindow, faults: { readFailure: (active: boolean) => void; disconnect: () => void; reconnect: () => Promise<void> }) {
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code: string) => {
    for (let i = 0; i < 80; i++) { if (await js<boolean>(code)) return; await sleep(100); }
    throw new Error(`运行配置验收超时：${code}`);
  };
  const click = (selector: string, text?: string) => js(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.trim() === ${JSON.stringify(text)}` : 'true'});
    if (!e || e.disabled) throw Error('控件不可用'); e.click();
  })()`);
  const input = (selector: string, value: string) => js(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || e.readOnly) throw Error('输入不可用');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)});
    e.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  const rpc = <T = unknown>(method: string, params?: unknown) => js<T>(`window.cueclock.rpc(${JSON.stringify(method)}, ${JSON.stringify(params)}).then(r=>{if(!r.ok) throw Error(r.error.message);return r.result;})`);
  const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  const original = await rpc<{ project: Project; rev: number; instanceId: string }>('getProject');
  assert(await js(`!!document.querySelector('.configuration-view.runtime') && document.querySelector('.projname').readOnly && document.querySelector('[data-runtime-state]').textContent.includes('已回读核对')`), '默认来源不是已核对的引擎只读配置');
  await click('.viewtabs span', '模式与时间轴');
  const cueTime = () => js<string>(`document.querySelector('.master-cue').dataset.time`);
  const before = await cueTime();
  await click('.master-cue');
  assert(await js(`document.querySelector('.inspector-fields').disabled && document.querySelector('.track-color').disabled && document.querySelector('.mode-actions .primary').disabled`), '运行配置仍能编辑');
  await js(`document.querySelector('.master-cue').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));document.querySelector('.target-track').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:800}));`);
  assert(await cueTime() === before, '只读时间轴被移动');
  await click('.configuration-switch button', '编辑草稿');
  await input('.projname', `${original.project.name}（隔离草稿）`);
  await click('.master-cue');
  await js(`document.querySelector('.master-cue').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
  const draftTime = await cueTime();
  assert(draftTime !== before, '草稿编辑未改变时间');
  await sleep(900);
  assert((await rpc<typeof original>('getProject')).project.timelines[0]!.cues[0]!.time === original.project.timelines[0]!.cues[0]!.time, '编辑草稿误改引擎');
  await click('.configuration-switch button', '查看正在运行');
  await wait(`document.querySelector('[data-runtime-state]').textContent.includes('已回读核对')`);
  assert(await cueTime() === before, '运行时间轴展示了草稿');
  await click('.configuration-switch button', '编辑草稿');
  assert(await cueTime() === draftTime, '切换丢失草稿');
  await click('.apply-open'); await wait(`!!document.querySelector('.apply-dialog')`);
  await click('.apply-dialog .mf button', '确认应用到运行');
  await wait(`!!document.querySelector('.configuration-view.runtime') && document.querySelector('[data-runtime-state]').textContent.includes('已回读核对') && !document.querySelector('.apply-dialog')`);
  const applied = await rpc<typeof original>('getProject');
  assert(applied.rev > original.rev && await cueTime() === draftTime && applied.project.name.endsWith('（隔离草稿）'), '应用后未展示引擎真实回读');
  await click('.configuration-switch button', '编辑草稿'); await input('.projname', '保留本机冲突草稿');
  await rpc('applyProject', { project: { ...applied.project, name: '独立RPC更新后的运行配置' }, baseRev: applied.rev, instanceId: applied.instanceId });
  await wait(`!!document.querySelector('.savestate.conflict')`);
  assert(await js(`document.querySelector('.projname').value === '保留本机冲突草稿'`), '外部修改覆盖草稿');
  await click('.configuration-switch button', '查看正在运行');
  await wait(`document.querySelector('.projname').value === '独立RPC更新后的运行配置' && document.querySelector('[data-runtime-state]').textContent.includes('已回读核对')`);
  await click('.configuration-switch button', '编辑草稿');
  assert(await js(`document.querySelector('.projname').value === '保留本机冲突草稿'`), '运行刷新丢失冲突草稿');
  await click('.top button', '放弃本地修改并重新加载');
  await wait(`!!document.querySelector('.savestate.saved') && document.querySelector('.projname').value === '独立RPC更新后的运行配置'`);
  await click('.configuration-switch button', '编辑草稿');
  await input('.projname', '应用成功但回读故障');
  await click('.apply-open'); await wait(`!!document.querySelector('.apply-dialog')`);
  faults.readFailure(true);
  try {
    await click('.apply-dialog .mf button', '确认应用到运行');
    await wait(`document.querySelector('[data-runtime-state]').textContent.includes('回读未核对')`);
    assert(!await js(`!!document.querySelector('.runtime-confirmed')`), '回读失败被误标已核对');
  } finally { faults.readFailure(false); }
  assert((await rpc<typeof original>('getProject')).project.name === '应用成功但回读故障', '故障场景中应用本身未成功');
  await click('.configuration-view > button', '刷新运行配置');
  await wait(`document.querySelector('[data-runtime-state]').textContent.includes('已回读核对')`);
  faults.disconnect();
  await wait(`document.querySelector('[data-runtime-state]').textContent.includes('连接断开')`);
  assert(!await js(`!!document.querySelector('.runtime-confirmed')`), '断线缓存被误标已核对');
  await faults.reconnect();
  await wait(`document.querySelector('[data-runtime-state]').textContent.includes('已回读核对')`);
  // 还原隔离夹具，后面的全页面压力检查不继承此测试的内容。
  const current = await rpc<typeof original>('getProject');
  await rpc('applyProject', { project: original.project, baseRev: current.rev, instanceId: current.instanceId });
  await wait(`document.querySelector('.projname').value === ${JSON.stringify(original.project.name)}`);
  await click('.configuration-switch button', '查看正在运行');
  await wait(`document.querySelector('[data-runtime-state]').textContent.includes('已回读核对')`);
  return { passed: true, checks: ['默认引擎回读只读', '只读禁止移动与新增', '草稿修改不改变引擎', '来回切换保留草稿', '确认应用后真实回读', '外部RPC更新与冲突草稿分离', '注入回读故障不误报核对', '实际断开客户端连接显示缓存，重连后重新核对'] };
}
