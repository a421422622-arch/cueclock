import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { listLogDays, pruneLogs, readLogDay, validLogKeepDays } from '../src/logfile.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { project } from './helpers.ts';

const line = (t: number, detail: string) => JSON.stringify({ t, dir: 'SYS', result: 'info', detail }) + '\n';

test('历史日志：按天列出（新的在前），读某一天跳过坏行，超过上限只给最后几条并标明截断', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '2026-10-01.jsonl'), line(1, 'a') + '{坏行\n' + line(2, 'b') + line(3, 'c'));
  await writeFile(path.join(dir, '2026-10-03.jsonl'), line(9, 'z'));
  await writeFile(path.join(dir, 'audit.jsonl'), 'x'); // 别的文件不算日志
  const days = await listLogDays(dir);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-03', '2026-10-01']);
  assert.ok(days[1]!.bytes > 0);
  const all = await readLogDay(dir, '2026-10-01', 100);
  assert.deepEqual(all.entries.map((e) => e.detail), ['a', 'b', 'c']);
  assert.equal(all.total, 3);
  assert.equal(all.truncated, false);
  const tail = await readLogDay(dir, '2026-10-01', 2);
  assert.deepEqual(tail.entries.map((e) => e.detail), ['b', 'c']);
  assert.equal(tail.truncated, true);
  assert.deepEqual((await readLogDay(dir, '2026-09-30', 10)).entries, []);
  await assert.rejects(readLogDay(dir, '../settings', 10), /日期格式/);
});

test('日志保留天数：0 = 永久，1~3650 有效；清理只删按天日志', async (t) => {
  assert.equal(validLogKeepDays(0), true);
  assert.equal(validLogKeepDays(365), true);
  assert.equal(validLogKeepDays(3651), false);
  assert.equal(validLogKeepDays(1.5), false);
  assert.equal(validLogKeepDays('30'), false);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '2020-01-01.jsonl'), line(1, 'old'));
  await writeFile(path.join(dir, 'audit.jsonl'), 'x');
  await pruneLogs(dir, 30, Date.parse('2026-10-08T12:00:00'));
  assert.deepEqual((await readdir(dir)).sort(), ['audit.jsonl']);
});

test('daemon：可以读历史日志、修改保留天数（重启后保持），且锁定时读日志不受限制', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-test-'));
  const file = path.join(dir, 'project.json');
  await writeFile(file, JSON.stringify({ ...project([]), settings: { localAddress: '127.0.0.1', recovery: { enabled: false } } }));
  const state = path.join(dir, 'state');
  let daemon = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  await daemon.start();
  let client = DaemonClient.forStateDir(state);
  await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });

  const opts0 = (await client.request('getRuntimeOptions')) as { logKeepDays: number; logsDir: string };
  assert.equal(opts0.logKeepDays, 30);
  assert.equal(opts0.logsDir, path.join(state, 'logs'));
  // 永久保留：旧日志不会被清理（默认 30 天时启动就会删掉超期的，所以先改设置再放旧日志）
  await client.request('setRuntimeOptions', { logKeepDays: 0 });
  await mkdir(path.join(state, 'logs'), { recursive: true });
  await writeFile(path.join(state, 'logs', '2026-01-02.jsonl'), line(5, '旧的一天'));
  const listed = (await client.request('listLogDays')) as { keepDays: number; days: { date: string }[] };
  assert.equal(listed.keepDays, 0);
  assert.ok(listed.days.some((d) => d.date === '2026-01-02'));
  const day = (await client.request('readLogDay', { date: '2026-01-02' })) as { entries: { detail: string }[] };
  assert.equal(day.entries[0]!.detail, '旧的一天');
  await assert.rejects(client.request('setRuntimeOptions', { logKeepDays: -1 }), /保留天数/);

  // 锁定后仍可读日志
  await client.request('setPassword', { password: 'abcd' });
  await client.request('lock');
  assert.ok(((await client.request('listLogDays')) as { days: unknown[] }).days.length > 0);
  await client.request('readLogDay', { date: '2026-01-02' });
  await assert.rejects(client.request('setRuntimeOptions', { logKeepDays: 7 }), /锁/);

  // 重启后保持
  client.close();
  await daemon.stop();
  daemon = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  await daemon.start();
  client = DaemonClient.forStateDir(state);
  await client.connect();
  assert.equal(((await client.request('getRuntimeOptions')) as { logKeepDays: number }).logKeepDays, 0);
  assert.ok(((await client.request('listLogDays')) as { days: { date: string }[] }).days.some((d) => d.date === '2026-01-02'), '永久保留时重启也不清理');
});
