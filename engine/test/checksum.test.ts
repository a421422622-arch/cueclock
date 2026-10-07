import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumBytes } from '../src/checksum.ts';
import { buildPayload } from '../src/payload.ts';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex').toUpperCase();
const nine = Buffer.from('123456789');

test('CRC16 标准测试向量（"123456789"）：Modbus 0x4B37、CCITT-FALSE 0x29B1、XMODEM 0x31C3，字节序按约定', () => {
  assert.equal(hex(checksumBytes(nine, { algo: 'crc16-modbus' })), '374B'); // 低字节在前
  assert.equal(hex(checksumBytes(nine, { algo: 'crc16-ccitt' })), '29B1');
  assert.equal(hex(checksumBytes(nine, { algo: 'crc16-xmodem' })), '31C3');
});

test('Modbus RTU 常见帧：01 03 00 00 00 0A → CRC C5 CD（低字节在前）', () => {
  assert.equal(hex(checksumBytes(Buffer.from('01030000000A', 'hex'), { algo: 'crc16-modbus' })), 'C5CD');
});

test('Sum8 / 取补码 / XOR8', () => {
  const d = Buffer.from([0xff, 0x02, 0x03]); // 和 = 0x104 → 0x04
  assert.equal(hex(checksumBytes(d, { algo: 'sum8' })), '04');
  assert.equal(hex(checksumBytes(d, { algo: 'sum8-neg' })), 'FC');
  assert.equal(hex(checksumBytes(d, { algo: 'xor8' })), 'FE'); // ff^02=fd, fd^03=fe
  assert.equal(hex(checksumBytes(Buffer.from([0x01, 0x02]), { algo: 'sum8-neg' })), 'FD'); // 01+02+FD = 0x100
  assert.equal(hex(checksumBytes(Buffer.alloc(0), { algo: 'sum8-neg' })), '00');
});

test('skip：帧头不参与计算；skip 超出长度按空内容，负数/小数当 0 / 取整', () => {
  const d = Buffer.from([0xaa, 0x55, 0x01, 0x02]);
  assert.equal(hex(checksumBytes(d, { algo: 'sum8', skip: 2 })), '03');
  assert.equal(hex(checksumBytes(d, { algo: 'sum8', skip: 99 })), '00');
  assert.equal(hex(checksumBytes(d, { algo: 'sum8', skip: -3 })), hex(checksumBytes(d, { algo: 'sum8' })));
  assert.equal(hex(checksumBytes(d, { algo: 'sum8', skip: 2.9 })), '03');
});

test('buildPayload：校验字节追加在内容后、结束符之前；HEX 与 ASCII 都支持；不改原有行为', () => {
  assert.equal(hex(buildPayload('hex', 'AA 01 02', 'none', { algo: 'sum8', skip: 1 })), 'AA010203');
  assert.equal(hex(buildPayload('ascii', 'AB', 'cr', { algo: 'xor8' })), '4142' + '03' + '0D');
  assert.equal(hex(buildPayload('hex', 'AA 01')), 'AA01');
  assert.equal(hex(buildPayload('ascii', 'AB', 'crlf')), '41420D0A');
});
