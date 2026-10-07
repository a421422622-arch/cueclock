import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PJLINK_TEMPLATES, pjlinkPatch } from '../src/lib/pjlink.ts';
import { previewPayload, toHex } from '../src/lib/payload.ts';
import { validateProject } from '../../engine/src/validate.ts';
import type { Command, Project } from '../../engine/src/types.ts';

test('PJLink 模板：每条都是 %1/%2 开头的 ASCII，回包期望和命令名对得上，生成的指令能通过引擎校验', () => {
  for (const t of PJLINK_TEMPLATES) {
    assert.match(t.payload, /^%1[A-Z]{4} /, t.label);
    const name = t.payload.slice(2, 6);
    assert.ok(t.reply.pattern.startsWith(`%1${name}=`), `${t.label}：回包期望应以 %1${name}= 开头`);
    assert.ok(t.reply.timeoutMs >= 1000);
    const patch = pjlinkPatch(t);
    const cmd: Command = { id: 'c', name: t.label, targets: ['D'], format: 'ascii', payload: '', ...patch };
    const p = { name: 'x', devices: [{ id: 'D', name: 'd', ip: '10.0.0.1' }], groups: [], timelines: [], triggers: [], commands: [cmd] } as Project;
    const bad = validateProject(p).filter((i) => i.level === 'error');
    assert.deepEqual(bad, [], t.label);
  }
});

test('套用模板：清掉结束符和校验和，端口不动（补丁里没有 port）；回包是独立副本', () => {
  const t = PJLINK_TEMPLATES[0]!;
  const patch = pjlinkPatch(t);
  assert.deepEqual([patch.protocol, patch.format, patch.payload, patch.terminator, patch.checksum], ['pjlink', 'ascii', '%1POWR 1', undefined, undefined]);
  assert.equal('port' in patch, false);
  patch.reply!.pattern = 'changed';
  assert.notEqual(PJLINK_TEMPLATES[0]!.reply.pattern, 'changed');
});

test('预览带校验和：字节与引擎一致（Modbus 示例 01 03 00 00 00 0A + CRC C5 CD）', () => {
  const p = previewPayload('hex', '01 03 00 00 00 0A', 'none', { algo: 'crc16-modbus' });
  assert.equal(toHex(p.bytes), '01 03 00 00 00 0A C5 CD');
  const a = previewPayload('ascii', 'AB', 'cr', { algo: 'xor8' });
  assert.equal(toHex(a.bytes), '41 42 03 0D');
  assert.equal(toHex(previewPayload('hex', 'AA 01').bytes), 'AA 01');
  assert.equal(previewPayload('hex', '', 'none', { algo: 'sum8' }).ok, false); // 空内容不会因为有校验字节而“合法”
});
