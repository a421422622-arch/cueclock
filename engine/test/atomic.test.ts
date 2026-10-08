import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameReplace } from '../src/atomic.ts';

const err = (code: string) => Object.assign(new Error(`${code}: busy`), { code });

test('Windows：目标被占用（EPERM / EBUSY / EACCES）时退避重试，放开后改名成功', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let calls = 0; const waits: number[] = [];
    await renameReplace('a.tmp', 'a', { platform: 'win32', rename: async () => { if (++calls < 4) throw err(code); }, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(calls, 4); assert.deepEqual(waits, [20, 40, 80]);
  }
});

test('重试用完仍被占用：抛出原错误（不吞掉）；最多尝试 10 次，退避不超过 500ms', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(renameReplace('a.tmp', 'a', { platform: 'win32', rename: async () => { calls++; throw err('EPERM'); }, sleep: async (ms) => { waits.push(ms); } }), { code: 'EPERM' });
  assert.equal(calls, 10); assert(waits.every((w) => w <= 500)); assert.equal(waits.length, 9);
});

test('不相关的错误（如目录不存在）立刻抛出，不重试', async () => {
  let calls = 0;
  await assert.rejects(renameReplace('a.tmp', 'a', { platform: 'win32', rename: async () => { calls++; throw err('ENOENT'); }, sleep: async () => {} }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('非 Windows 平台：只尝试一次，EPERM 也立刻抛出（行为不变）', async () => {
  let calls = 0;
  await assert.rejects(renameReplace('a.tmp', 'a', { platform: 'darwin', rename: async () => { calls++; throw err('EPERM'); }, sleep: async () => {} }), { code: 'EPERM' });
  assert.equal(calls, 1);
});

test('真实文件：改名覆盖已存在的目标', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'), path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-atomic-'));
  try {
    await writeFile(path.join(dir, 'a'), 'old'); await writeFile(path.join(dir, 'a.tmp'), 'new');
    await renameReplace(path.join(dir, 'a.tmp'), path.join(dir, 'a'));
    assert.equal(await readFile(path.join(dir, 'a'), 'utf8'), 'new');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
