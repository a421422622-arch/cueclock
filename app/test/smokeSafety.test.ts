import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedSmoke } from '../electron/smokeSafety.ts';
import { defaultStateDir } from '../../engine/src/paths.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('自检强制隔离：缺端口、47800、生产状态目录均拒绝，正确独立参数才放行', () => {
  for (const [port, state] of [[undefined, '/tmp/test'], ['47800', '/tmp/test'], ['0', '/tmp/test'], ['60000', undefined], ['60000', '/production']] as const) {
    assert.throws(() => assertIsolatedSmoke(port, state, '/production'), /自检/);
  }
  assert.doesNotThrow(() => assertIsolatedSmoke('60000', '/tmp/test', '/production'));
});

test('环境变量指定测试目录时，保护仍针对真实默认目录；符号链接也不能绕过', (t) => {
  const previous = process.env.CUECLOCK_HOME;
  process.env.CUECLOCK_HOME = '/tmp/cueclock-env-test';
  try { assert.notEqual(defaultStateDir(true), '/tmp/cueclock-env-test'); }
  finally { if (previous === undefined) delete process.env.CUECLOCK_HOME; else process.env.CUECLOCK_HOME = previous; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cueclock-smoke-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const production = path.join(dir, 'production'), alias = path.join(dir, 'alias');
  fs.mkdirSync(production); fs.symlinkSync(production, alias);
  assert.throws(() => assertIsolatedSmoke('60000', alias, production), /自检/);
});
