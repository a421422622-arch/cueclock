import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildLaunchAgentPlist, enableLaunchAgent, readLaunchAgent } from '../electron/autostartMac.ts';

test('登录守护可选：异常退出才拉起，普通退出保留操作者意图；节流避免崩溃循环', () => {
  const guarded = buildLaunchAgentPlist(['/a path/Electron', '应用路径'], true);
  assert.match(guarded, /<key>KeepAlive<\/key>[\s\S]*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(guarded, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert(!buildLaunchAgentPlist(['/x']).includes('KeepAlive'));
});

test('守护配置在独立家目录读写，不修改用户登录项', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cueclock-guardian-')); t.after(() => rm(home, { recursive: true, force: true }));
  await enableLaunchAgent(home, [process.execPath], true); assert.equal((await readLaunchAgent(home)).guardEnabled, true);
  await enableLaunchAgent(home, [process.execPath], false); assert.equal((await readLaunchAgent(home)).guardEnabled ?? false, false);
});
