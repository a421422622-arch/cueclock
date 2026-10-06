import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHealth, batchProblem, devicesByTag, devicesWithoutHealth, healthSummary, overwriteCount } from '../src/lib/batchHealth.ts';
import { intervalLabel } from '../src/lib/interval.ts';
import type { Project } from '../../engine/src/types.ts';

const p = (): Project => ({
  name: 'p', groups: [], timelines: [], triggers: [],
  devices: [
    { id: 'A', name: 'a', ip: '10.0.0.1', tag: '灯光', health: { mode: 'ping', intervalSec: 30 } },
    { id: 'B', name: 'b', ip: '10.0.0.2', tag: '灯光' },
    { id: 'C', name: 'c', ip: '10.0.0.3', tag: '投影', health: { mode: 'udp', intervalSec: 60, probe: { commandId: 'q' } } },
    { id: 'D', name: 'd', ip: '10.0.0.4' },
  ],
});

test('批量应用：只改选中的设备；覆盖已有设置；不修改入参；每台拿到独立副本', () => {
  const before = JSON.stringify(p());
  const src = p();
  const cfg = { mode: 'ping' as const, intervalSec: 10 };
  const out = applyHealth(src, ['A', 'B'], cfg);
  assert.equal(JSON.stringify(src), before, '入参不能被修改');
  assert.deepEqual(out.devices.map((d) => d.health), [{ mode: 'ping', intervalSec: 10 }, { mode: 'ping', intervalSec: 10 }, src.devices[2]!.health, undefined]);
  out.devices[0]!.health!.intervalSec = 99;
  assert.equal(out.devices[1]!.health!.intervalSec, 10, '各设备的设置互相独立');
  assert.equal(cfg.intervalSec, 10);
});

test('批量清除：config 为 null 时被选中的设备改为不检测（字段被去掉）', () => {
  const out = applyHealth(p(), ['A', 'C'], null);
  assert.deepEqual(out.devices.map((d) => 'health' in d), [false, false, false, false]);
});

test('覆盖计数：只算「原来已有且与新设置不同」的', () => {
  const cfg = { mode: 'ping' as const, intervalSec: 30 };
  assert.equal(overwriteCount(p(), ['A', 'B', 'C', 'D'], cfg), 1, 'A 与新设置相同不算覆盖，B/D 原来没有，只有 C 被覆盖');
  assert.equal(overwriteCount(p(), ['B', 'D'], cfg), 0);
  assert.equal(overwriteCount(p(), ['A', 'C'], null), 2, '清除也会覆盖已有设置');
});

test('可应用性：没选设备、UDP 没选指令都要提示', () => {
  assert.equal(batchProblem({ mode: 'ping' }, []), '请至少选择一台设备');
  assert.equal(batchProblem({ mode: 'udp' }, ['A']), 'UDP 探测需要先选择探测指令');
  assert.equal(batchProblem({ mode: 'udp', probe: { commandId: 'q' } }, ['A']), null);
  assert.equal(batchProblem(null, ['A']), null);
});

test('快捷选择与摘要文字', () => {
  assert.deepEqual(devicesWithoutHealth(p()), ['B', 'D']);
  assert.deepEqual(devicesByTag(p(), '灯光'), ['A', 'B']);
  assert.equal(healthSummary(undefined, intervalLabel), '不检测');
  assert.equal(healthSummary({ mode: 'ping', intervalSec: 90 }, intervalLabel), 'Ping · 每 1 分 30 秒');
  assert.equal(healthSummary({ mode: 'udp' }, intervalLabel), 'UDP 探测 · 每 30 秒');
});
