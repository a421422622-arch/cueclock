import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLaunchAgentPlist, disableLaunchAgent, enableLaunchAgent, launchAgentPath, readLaunchAgent } from '../electron/autostartMac.ts';

test('plist：标签、参数顺序、登录时运行、不常驻重启；特殊字符被转义', () => {
  const xml = buildLaunchAgentPlist(['/Apps/Cue & Clock/Electron', '/Users/中文 目录/app', '--hidden']);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.cueclock\.app<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(xml, /KeepAlive/);
  const strings = [...xml.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(strings.slice(1, 4), ['/Apps/Cue &amp; Clock/Electron', '/Users/中文 目录/app', '--hidden']);
});

test('启用 / 读取 / 停用：写到 LaunchAgents，停用后文件被删除', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cc-home-'));
  try {
    assert.deepEqual(await readLaunchAgent(home), { enabled: false, stale: false });
    const exe = path.join(home, 'fake-electron');
    await writeFile(exe, '');
    await enableLaunchAgent(home, [exe, '--hidden']);
    assert.ok(existsSync(launchAgentPath(home)));
    assert.deepEqual(await readLaunchAgent(home), { enabled: true, stale: false });
    await enableLaunchAgent(home, [exe, '--hidden']); // 重复启用是幂等的
    await disableLaunchAgent(home);
    assert.deepEqual(await readLaunchAgent(home), { enabled: false, stale: false });
    await disableLaunchAgent(home); // 重复停用不报错
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('程序被移动或删除后，已登记的启动项被标为失效（stale）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cc-home-'));
  try {
    const exe = path.join(home, 'will-vanish');
    await writeFile(exe, '');
    await enableLaunchAgent(home, [exe, '--hidden']);
    assert.equal((await readLaunchAgent(home)).stale, false);
    await rm(exe);
    assert.deepEqual(await readLaunchAgent(home), { enabled: true, stale: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('生成的 plist 能通过系统的 plutil 校验（仅 macOS）', { skip: process.platform !== 'darwin' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cc-home-'));
  try {
    await enableLaunchAgent(home, ['/Applications/Cue & Clock.app/Contents/MacOS/CueClock', '/x/中文 目录', '--hidden']);
    const r = spawnSync('plutil', ['-lint', launchAgentPath(home)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(await readFile(launchAgentPath(home), 'utf8'), /Cue &amp; Clock/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
