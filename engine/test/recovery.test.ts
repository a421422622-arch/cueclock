import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecovery } from '../src/recovery.ts';
import { localMidnight } from '../src/calendar.ts';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { project, RecordingTransport, udp } from './helpers.ts';
import type { Cue, Project } from '../src/types.ts';

const date = '2026-10-06';
const at = (hours: number) => localMidnight(date) + hours * 3_600_000;
const make = (cues: Cue[]): Project => project([{ id: 'mode', name: '工作日', cues }], {
  devices: [
    { id: 'D1', name: '灯光', ip: '127.0.0.1', port: 5000, tag: '展厅' },
    { id: 'D2', name: '投影', ip: '127.0.0.1', port: 5001, tag: '展厅' },
  ],
});
const sends = (p: Project) => planRecovery(p, date, at(12)).flatMap((r) => r.actions.map((x) => ({
  cue: r.cueId, targets: x.action.type === 'udp' ? x.action.targets : [],
  payload: x.action.type === 'udp' ? x.action.payload : '',
})));

test('同一模式下各目标分别恢复最近状态，较晚的投影事件不会遮掉灯光事件', () => {
  const p = make([
    { id: 'light', name: '灯光开', time: '09:00', actions: [udp('a', 'LIGHT', { chase: true })] },
    { id: 'projector', name: '投影开', time: '10:00', actions: [udp('b', 'PROJECTOR', { targets: ['D2'], chase: true })] },
  ]);
  assert.deepEqual(sends(p), [
    { cue: 'light', targets: ['D1'], payload: 'LIGHT' },
    { cue: 'projector', targets: ['D2'], payload: 'PROJECTOR' },
  ]);
});

test('共享标签事件按目标裁剪；某目标后来有不补发事件时不重放其旧状态', () => {
  const p = make([
    { id: 'all', name: '全部开', time: '09:00', actions: [udp('a', 'ALL', { targets: ['tag:展厅', 'D1'], chase: true })] },
    { id: 'play', name: '播放', time: '10:00', actions: [udp('b', 'PLAY', { targets: ['D2'], chase: false })] },
  ]);
  assert.deepEqual(sends(p), [{ cue: 'all', targets: ['D1'], payload: 'ALL' }]);
});

test('尚未发送的延时动作不覆盖旧状态；禁用事件不影响恢复', () => {
  const p = make([
    { id: 'old', name: '旧状态', time: '09:00', actions: [udp('a', 'OLD', { chase: true })] },
    { id: 'future', name: '延时', time: '11:00', actions: [{ id: 'delay', type: 'delay', ms: 7_200_000 }, udp('b', 'FUTURE', { chase: true })] },
    { id: 'off', name: '禁用', enabled: false, time: '11:30', actions: [udp('c', 'OFF', { chase: true })] },
  ]);
  assert.deepEqual(sends(p), [{ cue: 'old', targets: ['D1'], payload: 'OLD' }]);
});

test('模式恢复重复动作只按配置次数发送，并保留累计延时', async () => {
  const p = make([{ id: 'c', name: '开场', time: '09:00', actions: [
    { id: 'delay', type: 'delay', ms: 500 },
    udp('a', 'GO', { chase: true, repeat: 2, repeatGapMs: 100 }),
  ] }]);
  p.settings = { recovery: { delayMs: 0 } };
  const clock = new VirtualClock(at(12));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  try {
    await e.start();
    await clock.advanceTo(at(12) + 499);
    assert.equal(tr.sent.length, 0);
    await clock.advanceTo(at(12) + 600);
    assert.deepEqual(tr.sent.map((x) => x.text), ['GO', 'GO']);
  } finally {
    await e.stop();
  }
});
