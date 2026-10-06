import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandLabel, feedbackLabel, runningModes } from '../src/lib/operations.ts';
import { normalizeEngineStatus } from '../src/lib/status.ts';

test('运行状态文案：发出、确认、实际状态分别显示，过期不能显示为实时状态', () => {
  assert.equal(commandLabel(undefined), '尚无操作记录');
  assert.equal(commandLabel({ at: 0, result: 'sent', source: 'x' }), '已发送 · 未校验回包');
  assert.equal(commandLabel({ at: 0, result: 'confirmed', source: 'x' }), '回包已确认');
  assert.equal(feedbackLabel(undefined), '未知 · 尚无状态回读');
  assert.equal(feedbackLabel({ at: 0, values: { 电源: 'ON' }, stale: true }), '过期 · 电源：ON');
});

test('运行模式只用引擎的生效状态，运行时禁用不计为正在执行', () => {
  assert.deepEqual(runningModes([{ id: 'a', name: '工作日', active: true, runtimeDisabled: false, reason: '' }, { id: 'b', name: '周末', active: true, runtimeDisabled: true, reason: '' }]), ['工作日']);
});

test('旧引擎追加字段缺失时仍可渲染运行总览', () => {
  const s = normalizeEngineStatus({ running: true, paused: false, dryRun: false, now: 0, startedAt: 0, date: '', dayKind: '', timelines: [], listeners: [], upcoming: [] });
  assert.deepEqual(s?.devices, []);
  assert.deepEqual(s?.sceneRuns, []);
});
