import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProject } from '../src/validate.ts';
import { resolveCommandAction } from '../src/commands.ts';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import type { Command, Project } from '../src/types.ts';
import type { ReplyResult, SendOpts, Transport } from '../src/udp.ts';
import { project } from './helpers.ts';

const cmd = (extra: Partial<Command> = {}): Command => ({ id: 'c1', name: '开灯', targets: ['D1'], format: 'ascii', payload: 'ON', ...extra });
const errors = (p: Project) => validateProject(p).filter((i) => i.level === 'error').map((i) => i.message);
const warnings = (p: Project) => validateProject(p).filter((i) => i.level === 'warn').map((i) => i.message);

test('源端口校验：随机 / 1~65535 合法；非法值报错；和触发器监听端口相同报错；TCP 上只提示会被忽略', () => {
  assert.deepEqual(errors(project([], { commands: [cmd({ sourcePort: 'random' })] })), []);
  assert.deepEqual(errors(project([], { commands: [cmd({ sourcePort: 6000 })] })), []);
  assert.match(errors(project([], { commands: [cmd({ sourcePort: 70000 })] })).join(), /源端口 70000 非法/);
  assert.match(errors(project([], { commands: [cmd({ sourcePort: 'any' as never })] })).join(), /源端口 any 非法/);
  const trig = { id: 'T', name: '面板', port: 6000, allowFrom: ['*'], match: { kind: 'exact' as const, format: 'ascii' as const, pattern: 'GO' }, actions: [] };
  assert.match(errors(project([], { commands: [cmd({ sourcePort: 6000 })], triggers: [trig] })).join(), /触发器「面板」/);
  assert.match(warnings(project([], { commands: [cmd({ sourcePort: 6000, protocol: 'tcp' })] })).join(), /TCP \/ PJLink 不使用源端口/);
});

test('源端口：指令展开时带上，引擎发送时交给传输层', async () => {
  const r = resolveCommandAction(cmd({ sourcePort: 'random' }), { id: 'a', type: 'command', commandId: 'c1' });
  assert.equal(r.action?.sourcePort, 'random');
  const seen: (SendOpts | undefined)[] = [];
  const tr: Transport = {
    async send(_ip, _port, _d, opts) { seen.push(opts); },
    async sendAndWaitReply(): Promise<ReplyResult> { return { status: 'timeout' }; },
    async close() {},
  };
  const clock = new VirtualClock(Date.parse('2026-10-08T10:00:00'));
  const p = project([{ id: 't', name: 't', cues: [{ id: 'q', name: 'q', time: '09:00', actions: [{ id: 'a', type: 'command', commandId: 'c1' }] }] }], { commands: [cmd({ sourcePort: 7001 })] });
  const e = new Engine(p, { clock, transport: tr });
  await e.start();
  e.runCueNow('t', 'q');
  await clock.advanceTo(clock.now() + 1000);
  assert.equal(seen[0]?.sourcePort, 7001);
  e.stop();
});
