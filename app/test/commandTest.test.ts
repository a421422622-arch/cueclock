import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adHocCommand, describeStatus, requiredParams, runtimeOnly, summarize } from '../src/lib/commandTest.ts';

test('结果说明：只发送不冒充成功，回包符合才算确认', () => {
  assert.equal(describeStatus('confirmed').tone, 'ok');
  assert.equal(describeStatus('sent').tone, 'warn');
  assert.match(describeStatus('sent').text, /未知/);
  for (const s of ['mismatch', 'timeout', 'error'] as const) assert.equal(describeStatus(s).tone, 'bad');
});

test('整体结论：失败优先，其次等待中，其次仅发送', () => {
  assert.deepEqual(summarize({ actions: 1, pending: false, results: [{ device: 'a', status: 'confirmed' }, { device: 'b', status: 'confirmed' }] }), { text: '2 项全部成功', tone: 'ok' });
  assert.deepEqual(summarize({ actions: 1, pending: false, results: [{ device: 'a', status: 'confirmed' }, { device: 'b', status: 'timeout' }] }), { text: '1/2 项失败', tone: 'bad' });
  assert.equal(summarize({ actions: 1, pending: false, results: [{ device: 'a', status: 'sent' }] }).tone, 'warn');
  assert.equal(summarize({ actions: 1, pending: true, results: [] }).tone, 'warn');
  const none = summarize({ actions: 1, pending: false, results: [{ device: '', status: 'error' }] });
  assert.equal(none.tone, 'bad');
  assert.match(none.text, /没有可用的目标设备/);
});

test('必填参数：没有默认值的才算（空字符串默认值也算有默认）', () => {
  assert.deepEqual(requiredParams({ params: [{ name: 'a' }, { name: 'b', default: '' }, { name: 'c', default: '1' }] }), ['a']);
  assert.deepEqual(requiredParams({}), []);
});

test('运行时才有的值：触发器捕获与滑块占位符不能当场测试', () => {
  assert.equal(runtimeOnly('GO $1'), true);
  assert.equal(runtimeOnly('DIM {{ value }}'), true);
  assert.equal(runtimeOnly('AA {{hex}}'), true);
  assert.equal(runtimeOnly('SCENE {{n}}'), false);
  assert.equal(runtimeOnly('PRICE 5 USD'), false);
});

test('自定义 UDP 包成临时指令：带上目标/端口/回包，不带偏移', () => {
  const c = adHocCommand({ targets: ['D1'], port: 5000, format: 'hex', payload: 'AA', reply: null, repeat: 2 } as never);
  assert.deepEqual([c.id, c.targets, c.port, c.format, c.payload, c.repeat], ['__adhoc', ['D1'], 5000, 'hex', 'AA', 2]);
  assert.equal('offsetMs' in c, false);
});
