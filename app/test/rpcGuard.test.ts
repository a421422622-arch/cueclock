import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedByVersion } from '../electron/rpcGuard.ts';
import { assessEngine, ENGINE_VERSION } from '../../engine/src/version.ts';

const sameProtocolOldBuild = assessEngine({ protocol: 2, engineVersion: ENGINE_VERSION, engineBuild: 'older-build' });
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
