import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SleepGuard } from '../src/sleepguard.ts';

test('Mac后台防休眠：只启动一个属于本引擎的caffeinate，停用后释放', () => {
  const calls: unknown[] = []; let killed = 0;
  const guard = new SleepGuard('darwin', 12345, (binary, args) => { calls.push([binary, args]); return { kill: () => { killed++; }, unref: () => {}, on: () => {} }; });
  guard.set(true); guard.set(true);
  assert.deepEqual(calls, [['/usr/bin/caffeinate', ['-i', '-w', '12345']]]);
  guard.set(false); guard.set(false); assert.equal(killed, 1);
});

test('不支持的系统拒绝后台防休眠；子进程失败不会制造未处理异常', () => {
  const guard = new SleepGuard('win32', 1, () => { throw Error('不应启动'); });
  assert.throws(() => guard.set(true), /不支持/);
  let fail!: (e: Error) => void; const errors: string[] = [];
  const mac = new SleepGuard('darwin', 1, () => ({ kill: () => {}, unref: () => {}, on: (event, cb) => { if (event === 'error') fail = cb; } }), (e) => errors.push(e));
  mac.set(true); fail(Error('启动失败')); assert.deepEqual(errors, ['启动失败']);
});
