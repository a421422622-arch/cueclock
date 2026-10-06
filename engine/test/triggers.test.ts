import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceAllowed, TriggerRouter } from '../src/triggers.ts';
import type { Trigger } from '../src/types.ts';

test('来源白名单：IP / CIDR / * / 空', () => {
  assert.ok(sourceAllowed(['192.168.10.0/24'], '192.168.10.80'));
  assert.ok(!sourceAllowed(['192.168.10.0/24'], '192.168.11.80'));
  assert.ok(sourceAllowed(['10.0.0.5'], '10.0.0.5'));
  assert.ok(!sourceAllowed(['10.0.0.5'], '10.0.0.6'));
  assert.ok(sourceAllowed(['*'], '8.8.8.8'));
  assert.ok(!sourceAllowed([], '127.0.0.1'));
  assert.ok(sourceAllowed(['0.0.0.0/0'], '1.2.3.4'));
  assert.ok(!sourceAllowed(['bad', '1.2.3.4/99'], '1.2.3.4'));
});

const base: Trigger = {
  id: 't', name: 't', port: 9000, allowFrom: ['127.0.0.1'],
  match: { kind: 'exact', format: 'ascii', pattern: 'OPEN' }, actions: [],
};
const run = (t: Trigger, now: number, data = 'OPEN', ip = '127.0.0.1', router = new TriggerRouter([t])) =>
  router.route(9000, Buffer.from(data), ip, now)[0]!.result;

test('校验顺序：来源 → 口令 → 内容', () => {
  assert.equal(run(base, 0, 'OPEN', '10.0.0.1'), 'rejected-source');
  assert.equal(run(base, 0, 'NOPE'), 'no-match');
  assert.equal(run(base, 0), 'fire');
  const t = { ...base, passcode: 'KEY1:' };
  assert.equal(run(t, 0, 'OPEN'), 'rejected-passcode');
  assert.equal(run(t, 0, 'KEY1:OPEN'), 'fire');
  assert.equal(run(t, 0, 'KEY1:OTHER'), 'no-match');
});

test('其他端口的包不会被路由', () => {
  assert.deepEqual(new TriggerRouter([base]).route(9999, Buffer.from('OPEN'), '127.0.0.1', 0), []);
});

test('防抖', () => {
  const t = { ...base, debounceMs: 300 };
  const r = new TriggerRouter([t]);
  assert.equal(run(t, 1000, 'OPEN', '127.0.0.1', r), 'fire');
  assert.equal(run(t, 1200, 'OPEN', '127.0.0.1', r), 'debounced');
  assert.equal(run(t, 1300, 'OPEN', '127.0.0.1', r), 'fire');
});

test('频率限制：每分钟上限', () => {
  const t = { ...base, maxPerMinute: 2 };
  const r = new TriggerRouter([t]);
  assert.equal(run(t, 0, 'OPEN', '127.0.0.1', r), 'fire');
  assert.equal(run(t, 1000, 'OPEN', '127.0.0.1', r), 'fire');
  assert.equal(run(t, 2000, 'OPEN', '127.0.0.1', r), 'rate-limited');
  assert.equal(run(t, 61_001, 'OPEN', '127.0.0.1', r), 'fire');
});

test('二次确认：窗口内第二个包才执行，超时重新计', () => {
  const t = { ...base, requireConfirm: true, confirmWindowMs: 5000 };
  const r = new TriggerRouter([t]);
  assert.equal(run(t, 0, 'OPEN', '127.0.0.1', r), 'awaiting-confirm');
  assert.equal(run(t, 1000, 'OPEN', '127.0.0.1', r), 'fire');
  assert.equal(run(t, 2000, 'OPEN', '127.0.0.1', r), 'awaiting-confirm'); // 重新开始
  assert.equal(run(t, 9000, 'OPEN', '127.0.0.1', r), 'awaiting-confirm'); // 超过窗口，当作第一个
  assert.equal(run(t, 10_000, 'OPEN', '127.0.0.1', r), 'fire');
});

test('正则捕获组随结果返回', () => {
  const t: Trigger = { ...base, match: { kind: 'regex', format: 'ascii', pattern: '^SCENE (\\d+)$' } };
  const out = new TriggerRouter([t]).route(9000, Buffer.from('SCENE 7\r\n'), '127.0.0.1', 0)[0]!;
  assert.deepEqual([out.result, out.captures], ['fire', ['7']]);
});
