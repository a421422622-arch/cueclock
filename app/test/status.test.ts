import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEngineStatus } from '../src/lib/status.ts';
import type { EngineStatusMessage } from '../src/lib/status.ts';

const legacy = (): EngineStatusMessage => ({
  running: true, paused: false, dryRun: false, now: 1, startedAt: 1,
  date: '2026-10-06', dayKind: '普通工作日', timelines: [], listeners: [], upcoming: [], network: {},
});
test('旧引擎的 network={} 补齐 missing，顶栏与设置不会读取 undefined.length', () => {
  const raw = legacy();
  const result = normalizeEngineStatus(raw)!;
  assert.deepEqual(result.network.missing, []);
  assert.equal(result.network.missing.length, 0);
  assert.equal(result.running, true);
  assert.deepEqual(raw.network, {}, '不修改收到的原始状态');
});
test('网络状态整体省略时仍可显示自动网卡', () => {
  const raw = legacy();
  delete raw.network;
  const result = normalizeEngineStatus(raw)!;
  assert.deepEqual(result.network, { missing: [] });
});
test('新引擎已返回的网卡和缺失信息原样保留', () => {
  const raw = legacy();
  const missing = ['192.0.2.1'];
  raw.network = { localAddresses: ['192.0.2.1', '127.0.0.1'], localPort: 5000, listenAll: true, missing };
  const result = normalizeEngineStatus(raw)!;
  assert.deepEqual(result.network, raw.network);
  assert.equal(result.network.missing, missing);
});
test('引擎未运行时保持 null，不伪造运行状态', () => {
  assert.equal(normalizeEngineStatus(null), null);
});
