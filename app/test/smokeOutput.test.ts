import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { writeThenExit } from '../electron/smokeOutput.ts';

test('成功stdout及失败stderr的大报告写完后才退出', async () => {
  for (const code of [0, 1]) {
    let body = '', finished = false, exited = -1;
    const stream = new Writable({ highWaterMark: 8, write(chunk, _enc, done) { setTimeout(() => { body += chunk.toString();finished = true;done(); }, 10); } });
    const payload = 'SMOKE_UI ' + JSON.stringify({ ready: code === 0, detail: '诊断'.repeat(100000) });
    const task = writeThenExit(payload, code, stream, (c) => { assert(finished);exited = c; });
    assert.equal(exited, -1);await task;assert.equal(exited, code);assert.equal(body, payload+'\n');
  }
});
test('输出管道失败时仍以失败码退出，不留挂起自检', async () => {
  let code = -1;const stream = new Writable({ write(_chunk, _enc, done) { done(new Error('broken pipe')); } });
  stream.on('error', () => {});
  await writeThenExit('SMOKE_APP {}', 0, stream, (c) => { code = c; });assert.equal(code, 1);
});
