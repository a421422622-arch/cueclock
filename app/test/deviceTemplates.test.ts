import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TEMPLATES, fromTemplate, newCommandFor } from '../src/lib/deviceTemplates.ts';
import { validateProject } from '../../engine/src/validate.ts';
import type { Project } from '../../engine/src/types.ts';

test('每个设备模板建出来的设备和指令都能通过引擎校验（没有错误）', () => {
  let n = 0;
  for (const tpl of DEVICE_TEMPLATES) {
    const made = fromTemplate(tpl, { device: `d-${tpl.id}`, command: () => `c${++n}` }, '#ff9900');
    const p: Project = { name: 't', devices: [made.device], commands: made.commands, groups: [], timelines: [], triggers: [] };
    const errors = validateProject(p).filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], `${tpl.label}：${errors.map((e) => e.message).join('；')}`);
    for (const c of made.commands) assert.deepEqual(c.targets, [`d-${tpl.id}`]);
  }
});

test('PJLink 模板一起建好开机 / 关机 / 查询电源，并带回包校验', () => {
  const made = fromTemplate(DEVICE_TEMPLATES.find((t) => t.id === 'pjlink')!, { device: 'd1', command: (() => { let i = 0; return () => `c${++i}`; })() }, '#fff');
  assert.deepEqual(made.commands.map((c) => [c.name, c.protocol, c.payload]), [
    ['新投影机 · 开机', 'pjlink', '%1POWR 1'], ['新投影机 · 关机', 'pjlink', '%1POWR 0'], ['新投影机 · 查询电源', 'pjlink', '%1POWR ?'],
  ]);
  assert.ok(made.commands.every((c) => c.reply));
});

test('新建指令沿用选中设备的端口、格式和结束符', () => {
  const c = newCommandFor({ id: 'd', name: 'x', ip: '1.2.3.4', port: 6000, format: 'ascii', terminator: 'cr' }, 'c');
  assert.deepEqual([c.targets, c.port, c.format, c.terminator], [['d'], 6000, 'ascii', 'cr']);
  const h = newCommandFor({ id: 'd', name: 'x', ip: '1.2.3.4', format: 'hex' }, 'c');
  assert.deepEqual([h.port, h.format, h.terminator], [5000, 'hex', undefined]);
  assert.deepEqual(newCommandFor(undefined, 'c').targets, []);
});
