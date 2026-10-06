import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDeviceState } from '../src/lib/deviceState.ts';
import type { DeviceHealthInfo } from '../../engine/src/engine.ts';

const info = (p: Partial<DeviceHealthInfo>): DeviceHealthInfo => ({ id: 'D', state: 'online', method: 'ping', fails: 0, lastCheckAt: 1000, lastOkAt: 1000, ...p });

test('状态灯：禁用/未检测/在线/异常/离线', () => {
  assert.equal(describeDeviceState(info({}), false, 2000).light, 'disabled');
  assert.equal(describeDeviceState(undefined, true, 2000).light, 'unknown');
  assert.equal(describeDeviceState(info({ state: 'unknown', method: null }), true, 2000).light, 'unknown');
  assert.equal(describeDeviceState(info({ state: 'unknown' }), true, 2000).light, 'unknown');
  assert.equal(describeDeviceState(info({}), true, 2000).light, 'on');
  assert.equal(describeDeviceState(info({ state: 'failing', fails: 2 }), true, 2000).light, 'warn');
  assert.equal(describeDeviceState(info({ state: 'offline', fails: 3 }), true, 2000).light, 'off');
});

test('Ping 在线的说明必须写明「只说明网络层通」，不能让人误读成设备程序正常；UDP 探测则说明回包正确', () => {
  assert.match(describeDeviceState(info({ method: 'ping' }), true, 2000).title, /仅说明网络层通不通/);
  assert.match(describeDeviceState(info({ method: 'udp' }), true, 2000).title, /正确回包/);
  assert.match(describeDeviceState(info({ method: 'reply' }), true, 2000).title, /并非定时检测/);
});

test('文字：方式名、失败次数、多久前、往返时间', () => {
  const d = describeDeviceState(info({ state: 'offline', fails: 3, lastCheckAt: 0 }), true, 125_000);
  assert.deepEqual([d.label, /连续失败 3 次/.test(d.title), /2 分钟前/.test(d.title)], ['Ping 离线', true, true]);
  assert.match(describeDeviceState(info({ rttMs: 4.2 }), true, 1500).title, /4\.2ms/);
});
