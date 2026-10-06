import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedByVersion } from '../electron/rpcGuard.ts';
import { assessEngine, engineHello, ENGINE_VERSION } from '../../engine/src/version.ts';

const sameProtocolOldBuild = assessEngine({ ...engineHello(), engineBuild: 'older-build' });
const oldProtocol = assessEngine({ protocol: 1 });

test('协议兼容、仅构建不同：写操作照常放行（现场有日程在跑时不能连保存都不行）', () => {
  assert.equal(sameProtocolOldBuild.needsRestart, true);
  assert.equal(sameProtocolOldBuild.compatible, true);
  for (const m of ['saveProject', 'testSend', 'runCue', 'runCommand', 'setNetwork', 'openProject']) {
    assert.equal(isBlockedByVersion(m, sameProtocolOldBuild), false, m);
  }
});

test('协议不兼容：写操作被拦，只读和急停放行', () => {
  for (const m of ['saveProject', 'testSend', 'runCue', 'runCommand', 'setNetwork', 'openProject', 'newProject', 'shutdown']) {
    assert.equal(isBlockedByVersion(m, oldProtocol), true, m);
  }
  for (const m of ['status', 'getProject', 'getLogs', 'simulate', 'pause', 'resume']) {
    assert.equal(isBlockedByVersion(m, oldProtocol), false, m);
  }
});

test('握手信息缺失（null）不拦截', () => {
  assert.equal(isBlockedByVersion('saveProject', null), false);
});

test('同协议但功能版本过旧：不能把接管或顺序场景配置交给旧引擎', () => {
  const old = assessEngine({ protocol: 2, engineVersion: '0.2.0', engineBuild: 'old' });
  assert.equal(old.compatible, false);
  assert.equal(isBlockedByVersion('saveProject', old), true);
  assert.equal(isBlockedByVersion('setDeviceOverride', old), true);
  assert.equal(isBlockedByVersion('pause', old), false);
});

test('版本号相同但缺少所需能力：仍然提示更新并拒绝新配置写入', () => {
  const partial = assessEngine({ ...engineHello(), capabilities: ['operation-status'] });
  assert.equal(partial.compatible, false);
  assert.equal(partial.needsRestart, true);
  assert.equal(isBlockedByVersion('applyProject', partial), true);
});
