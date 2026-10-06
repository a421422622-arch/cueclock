import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import type { LogEntry } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { validateProject } from '../src/validate.ts';
import { snapSliderValue, hexOf, substituteSliderAction } from '../src/padvalue.ts';
import type { PadTile, Project } from '../src/types.ts';
import { project, RecordingTransport, udp } from './helpers.ts';

const at = (h: number) => localMidnight('2026-09-28') + h * 3600_000;

const slider = (id: string, extra: Partial<PadTile> = {}): PadTile => ({
  id, label: id, kind: 'slider', min: 0, max: 100, step: 1,
  actions: [udp('a', 'DIM {{value}}', { targets: ['L'] })],
  ...extra,
});
const mk = (tiles: PadTile[], extra: Partial<Project> = {}): Project => ({
  ...project([]),
  devices: [{ id: 'L', name: '灯', ip: '10.0.0.1', port: 5000 }],
  commands: [{ id: 'dim', name: '调光', targets: ['L'], format: 'ascii', payload: 'LV={{level}}', params: [{ name: 'level' }] }],
  scenes: [{ id: 'sc', name: '场景', actions: [udp('x', 'X', { targets: ['L'] })] }],
  pads: [{ id: 'pad', name: '展厅', tiles }],
  ...extra,
});
const issues = (p: Project) => validateProject(p).map((i) => `${i.level}|${i.path}|${i.message}`);
const errs = (p: Project) => issues(p).filter((x) => x.startsWith('error')).join('\n');
const warns = (p: Project) => issues(p).filter((x) => x.startsWith('warn')).join('\n');

function setup(tiles: PadTile[], extra: Partial<Project> = {}, padState?: Record<string, boolean | number>) {
  const clock = new VirtualClock(at(10));
  const tr = new RecordingTransport();
  const e = new Engine(mk(tiles, extra), { clock, transport: tr, padState });
  const logs: LogEntry[] = [];
  e.on('log', (l: LogEntry) => logs.push(l));
  return { e, tr, clock, logs, sent: () => tr.sent.map((s) => s.text) };
}

test('取值吸附：限制在范围内、按步长取整、消除浮点尾巴，非数字拒绝', () => {
  const t = { min: 0, max: 100, step: 5 } as PadTile;
  assert.equal(snapSliderValue(t, 42), 40);
  assert.equal(snapSliderValue(t, 43), 45);
  assert.equal(snapSliderValue(t, -9), 0);
  assert.equal(snapSliderValue(t, 1e9), 100);
  const f = { min: 0, max: 1, step: 0.1 } as PadTile;
  assert.equal(snapSliderValue(f, 0.30000000000000004), 0.3);
  assert.equal(snapSliderValue(f, 0.7), 0.7);
  assert.equal(snapSliderValue({ min: 10, max: 20, step: 3 } as PadTile, 20), 20); // 终点不在步长上也能取到
  assert.throws(() => snapSliderValue(t, NaN));
  assert.throws(() => snapSliderValue(t, Infinity));
  assert.throws(() => snapSliderValue(t, '5' as unknown as number));
});

test('{{hex}}：大写、补成偶数位；负数和小数拒绝', () => {
  assert.equal(hexOf(0), '00');
  assert.equal(hexOf(5), '05');
  assert.equal(hexOf(255), 'FF');
  assert.equal(hexOf(300), '012C');
  assert.throws(() => hexOf(-1));
  assert.throws(() => hexOf(1.5));
});

test('代入只处理 {{value}}/{{hex}}（允许空格），其他文本原样；指令参数同样代入', () => {
  const a = substituteSliderAction(udp('u', 'A {{ value }} B {{hex}} {{other}} $1', { targets: ['L'] }), 255);
  assert.equal((a as { payload: string }).payload, 'A 255 B FF {{other}} $1');
  const c = substituteSliderAction({ id: 'c', type: 'command', commandId: 'dim', args: { level: '{{value}}%' } }, 7);
  assert.deepEqual((c as { args: unknown }).args, { level: '7%' });
});

test('运行：自定义 UDP 与指令参数都带上滑块当前值；状态记下数值（0 也保留）', async () => {
  const s = setup([
    slider('raw'),
    slider('cmd', { actions: [{ id: 'c', type: 'command', commandId: 'dim', args: { level: '{{value}}' } }] }),
    slider('hex', { max: 255, actions: [udp('h', 'AA {{hex}} 55', { targets: ['L'], format: 'hex' })] }),
  ]);
  await s.e.start();
  assert.deepEqual(s.e.runPadTile('pad', 'raw', undefined, { value: 42 }), { actions: 1, state: 42 });
  s.e.runPadTile('pad', 'cmd', undefined, { value: 7 });
  s.e.runPadTile('pad', 'hex', undefined, { value: 255 });
  await s.clock.advanceTo(s.clock.now() + 100);
  assert.deepEqual(s.sent(), ['DIM 42', 'LV=7', '\xAAÿU'.replace('ÿ', '\xFF')]);
  assert.deepEqual(s.e.status().pads, { 'pad/raw': 42, 'pad/cmd': 7, 'pad/hex': 255 });
  s.e.runPadTile('pad', 'raw', undefined, { value: 0 });
  assert.equal(s.e.status().pads['pad/raw'], 0);
  await s.e.reload(mk([slider('raw'), slider('cmd'), slider('hex')])); // 项目热更新时清理状态不能误删 0
  assert.equal(s.e.status().pads['pad/raw'], 0);
  await s.e.stop();
});

test('拖动节流：中间值 30ms 内的会被忽略；松手的最终值永远执行，且只有最终值写系统日志', async () => {
  const s = setup([slider('d')]);
  await s.e.start();
  assert.equal(s.e.runPadTile('pad', 'd', undefined, { value: 10, final: false }).ignored, undefined);
  assert.equal(s.e.runPadTile('pad', 'd', undefined, { value: 11, final: false }).ignored, true); // 同一毫秒，太快
  await s.clock.advanceTo(s.clock.now() + 31);
  assert.equal(s.e.runPadTile('pad', 'd', undefined, { value: 12, final: false }).ignored, undefined);
  assert.equal(s.e.runPadTile('pad', 'd', undefined, { value: 13, final: true }).ignored, undefined); // 紧跟着的最终值不会被吞
  await s.clock.advanceTo(s.clock.now() + 100);
  assert.deepEqual(s.sent(), ['DIM 10', 'DIM 12', 'DIM 13']);
  assert.equal(s.e.status().pads['pad/d'], 13);
  const sys = s.logs.filter((l) => l.dir === 'SYS' && l.source?.startsWith('面板'));
  assert.equal(sys.length, 1);
  assert.match(sys[0]!.detail ?? '', /滑块设为 13/);
  await s.e.stop();
});

test('滑块必须带 value；超出范围的值被限制；急停期间照常可用', async () => {
  const s = setup([slider('d', { min: 10, max: 20 })]);
  await s.e.start();
  assert.throws(() => s.e.runPadTile('pad', 'd'), /需要 value/);
  assert.equal(s.e.runPadTile('pad', 'd', undefined, { value: 999 }).state, 20);
  s.e.pause();
  await s.clock.advanceTo(s.clock.now() + 100);
  s.e.runPadTile('pad', 'd', undefined, { value: 15 });
  await s.clock.advanceTo(s.clock.now() + 100);
  assert.deepEqual(s.sent(), ['DIM 20', 'DIM 15']);
  await s.e.stop();
});

test('状态恢复：引擎重启后读回滑块数值；非法值被忽略', async () => {
  const s = setup([slider('d')], {}, { 'pad/d': 33, 'pad/gone': 5, 'pad/x': 'oops' as unknown as number });
  await s.e.start();
  assert.deepEqual(s.e.status().pads, { 'pad/d': 33 });
  s.e.resetPadState('pad');
  assert.deepEqual(s.e.status().pads, {});
  await s.e.stop();
});

test('校验：范围、步长、初始值', () => {
  assert.equal(errs(mk([slider('d')])), '');
  assert.match(errs(mk([slider('d', { min: 5, max: 5 })])), /最小值必须小于最大值/);
  assert.match(errs(mk([slider('d', { step: 0 })])), /步长必须大于 0/);
  assert.match(errs(mk([slider('d', { step: -1 })])), /步长必须大于 0/);
  assert.match(errs(mk([slider('d', { min: 0, max: 100000, step: 1 })])), /档位太多/);
  assert.match(errs(mk([slider('d', { initial: 500 })])), /初始值不在范围内/);
  assert.match(errs(mk([slider('d', { min: NaN })])), /必须是数字/);
});

test('校验：动作不能含场景/时间线控制；没有占位符给警告；确认被忽略给警告', () => {
  assert.match(errs(mk([slider('d', { actions: [{ id: 's', type: 'scene', sceneId: 'sc' }] })])), /滑块里不能使用场景/);
  assert.match(errs(mk([slider('d', { actions: [{ id: 't', type: 'timeline', op: 'disable', target: 'G' }] })])), /不能放「时间线控制」/);
  assert.match(warns(mk([slider('d', { actions: [udp('a', 'FIXED', { targets: ['L'] })] })])), /不会变化/);
  assert.match(warns(mk([slider('d', { confirm: true })])), /不支持「需要确认」/);
  assert.match(errs(mk([slider('d', { actions: [{ id: 'c', type: 'command', commandId: 'nope', args: { level: '{{value}}' } }] })])), /找不到指令/);
});

test('校验：HEX 内容用 {{hex}} 合法；用 {{hex}} 时要求非负整数范围；{{value}} 放进 HEX 内容里会被发现', () => {
  const hexAct = [udp('h', 'AA {{hex}} 55', { targets: ['L'], format: 'hex' })];
  assert.equal(errs(mk([slider('d', { max: 255, actions: hexAct })])), '');
  assert.match(errs(mk([slider('d', { min: -5, max: 5, actions: hexAct })])), /\{\{hex\}\}.*整数/);
  assert.match(errs(mk([slider('d', { step: 0.5, actions: hexAct })])), /\{\{hex\}\}.*整数/);
  assert.match(errs(mk([slider('d', { min: 0, max: 255, actions: [udp('h', 'AA {{value}}', { targets: ['L'], format: 'hex' })] })])), /发送内容无效|无效/); // 十进制 0 作为 HEX 只有一位 → 奇数位
});

test('旧类型校验不受影响：未知类型仍然报错', () => {
  assert.match(errs(mk([{ ...slider('d'), kind: 'dial' as PadTile['kind'] }])), /不支持/);
});
