import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { validateProject } from '../src/validate.ts';
import type { Action, Project, Trigger } from '../src/types.ts';
import { fakeDevice, freePort, project, RecordingTransport, udp, waitFor } from './helpers.ts';
import dgram from 'node:dgram';

const base: Trigger = { id: 'tr', name: '捕获参数', port: 9000, allowFrom: ['127.0.0.1'],
  match: { kind: 'regex', format: 'ascii', pattern: '^SCENE (\\d+)$' }, actions: [] };
async function execute(trigger: Trigger, packet: string, extra: Partial<Project> = {}) {
  const p = project([], { ...extra, triggers: [trigger] });
  const clock = new VirtualClock(new Date(2026, 9, 6, 12).getTime());
  const transport = new RecordingTransport();
  const engine = new Engine(p, { clock, transport, dryRun: true });
  try {
    await engine.start();
    (engine as unknown as { onPacket(port: number, data: Buffer, ip: string, from: number): void }).onPacket(trigger.port, Buffer.from(packet), '127.0.0.1', 5000);
    await clock.advanceTo(clock.now() + 1);
    return transport.sent.map((s) => s.text);
  } finally { await engine.stop(); }
}
test('正则捕获传入指令参数与 UDP 内容；$0 是去口令和尾换行后的整个内容', async () => {
  const actions: Action[] = [
    { id: 'cmd-use', type: 'command', commandId: 'cmd', args: { 场景号: '$1' } },
    udp('raw', 'ALL=$0 GROUP=$1 DOLLAR=$$'),
  ];
  const trigger = { ...base, passcode: 'KEY:', actions };
  const before = JSON.stringify(trigger);
  assert.deepEqual(await execute(trigger, 'KEY:SCENE 7\r\n', {
    commands: [{ id: 'cmd', name: '切场景', targets: ['D1'], format: 'ascii', payload: 'SCENE {{场景号}}', params: [{ name: '场景号' }] }],
  }), ['SCENE 7', 'ALL=SCENE 7 GROUP=7 DOLLAR=$']);
  assert.equal(JSON.stringify(trigger), before, '不能把本次网络参数写回项目');
});

test('真实 UDP 回环：捕获传入指令参数，网络反斜杠不会注入字节', async () => {
  const device = await fakeDevice();
  const port = await freePort();
  const trigger = { ...base, port, passcode: 'KEY:', match: { kind: 'regex' as const, format: 'ascii' as const, pattern: '^DATA (.*)$' },
    actions: [{ id: 'a', type: 'command' as const, commandId: 'cmd', args: { data: '$1' } }] };
  const p = project([], { devices: [{ id: 'D1', name: '回环', ip: '127.0.0.1', port: device.port }], triggers: [trigger],
    commands: [{ id: 'cmd', name: '回传', targets: ['D1'], format: 'ascii', payload: 'COPY {{data}}', params: [{ name: 'data' }] }] });
  const engine = new Engine(p);
  const socket = dgram.createSocket('udp4');
  try {
    await engine.start();
    await new Promise<void>((r, reject) => socket.send(Buffer.from('KEY:DATA \\x41\\n$2\r\n'), port, '127.0.0.1', e => e ? reject(e) : r()));
    await waitFor(() => device.received.length === 1);
    assert.deepEqual(device.received[0], Buffer.from('COPY \\x41\\n$2'));
  } finally { socket.close(); await engine.stop(); await device.close(); }
});
test('网络捕获的反斜杠按字面发送，不执行 \\x、\\n 转义，也不递归替换 $2', async () => {
  const trigger = { ...base, match: { kind: 'regex' as const, format: 'ascii' as const, pattern: '^DATA (.*)$' }, actions: [udp('a', 'COPY $1')] };
  assert.deepEqual(await execute(trigger, 'DATA \\x41\\n$2'), ['COPY \\x41\\n$2']);
});
test('非正则触发器保留 $GPGGA、$1 和 $$ 原文', async () => {
  assert.deepEqual(await execute({ ...base, match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [udp('a', '$GPGGA $1 $$')] }, 'GO'), ['$GPGGA $1 $$']);
});
test('可选捕获组未参与匹配时取空串；$$1 发送字面 $1', async () => {
  const trigger = { ...base, match: { kind: 'regex' as const, format: 'ascii' as const, pattern: '^GO(?: (\\d+))?$' }, actions: [udp('a', 'VALUE[$1] $$1')] };
  assert.deepEqual(await execute(trigger, 'GO'), ['VALUE[] $1']);
});
test('HEX 发送内容可代入 ASCII 正则捕获，代入后的字节仍须合法', async () => {
  const trigger = { ...base, match: { kind: 'regex' as const, format: 'ascii' as const, pattern: '^BYTE ([0-9A-F]{2})$' }, actions: [udp('a', 'A5 $1', { format: 'hex' })] };
  const sent = await execute(trigger, 'BYTE 01');
  assert.deepEqual([...Buffer.from(sent[0]!, 'latin1')], [0xa5, 0x01]);
});
test('保存前拒绝越界 $N 和未支持的 $10；转义 $$9 不算引用', () => {
  for (const payload of ['$2', '$9', '$10']) {
    const issues = validateProject(project([], { triggers: [{ ...base, actions: [udp('a', payload)] }] }));
    assert(issues.some((i) => i.level === 'error' && /捕获/.test(i.message)), payload);
  }
  assert.equal(validateProject(project([], { triggers: [{ ...base, actions: [udp('a', '$$9')] }] })).filter(i => i.level === 'error').length, 0);
});
test('非捕获括号不计数，命名捕获组可以按位置编号引用', () => {
  const p = project([], { triggers: [{ ...base, match: { kind: 'regex', format: 'ascii', pattern: '^(?:SCENE )(?<scene>\\d+)$' }, actions: [udp('a', '$1')] }] });
  assert.equal(validateProject(p).filter(i => i.level === 'error').length, 0);
  p.triggers[0]!.actions = [udp('a', '$2')];
  assert(validateProject(p).some(i => i.level === 'error' && /捕获/.test(i.message)));
});
