import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_LOCK_MS, checkNewPassword, shouldAutoLock, summaryText } from '../src/lib/lockUi.ts';

test('自动上锁：只有设了密码且已解锁、闲置达到时限才锁', () => {
  const on = { enabled: true, unlocked: true };
  assert.equal(shouldAutoLock(on, 0, AUTO_LOCK_MS - 1), false);
  assert.equal(shouldAutoLock(on, 0, AUTO_LOCK_MS), true);
  assert.equal(shouldAutoLock({ enabled: true, unlocked: false }, 0, 1e12), false, '本来就锁着');
  assert.equal(shouldAutoLock({ enabled: false, unlocked: true }, 0, 1e12), false, '没设密码');
});

test('新密码校验：长度与两次一致', () => {
  assert.equal(checkNewPassword('abc', 'abc'), '密码至少 4 个字符');
  assert.equal(checkNewPassword('abcd', 'abce'), '两次输入的密码不一致');
  assert.equal(checkNewPassword('x'.repeat(129), 'x'.repeat(129)), '密码最多 128 个字符');
  assert.equal(checkNewPassword('abcd', 'abcd'), null);
});

test('备份概要文字：0 的项不显示，全 0 显示空配置', () => {
  assert.equal(summaryText({ devices: 3, timelines: 2, cues: 12, commands: 0, scenes: 1, triggers: 0 }), '3 设备 · 2 模式 · 12 事件点 · 1 场景');
  assert.equal(summaryText({ devices: 0, timelines: 0, cues: 0, commands: 0, scenes: 0, triggers: 0 }), '空配置');
});
