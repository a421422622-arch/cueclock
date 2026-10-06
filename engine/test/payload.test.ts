import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, describeAscii, formatHex, parseAscii, parseHex, PayloadError } from '../src/payload.ts';
import { matchBuffer } from '../src/match.ts';
import { formatTime, parseTime } from '../src/time.ts';

test('ASCII 转义', () => {
  assert.deepEqual([...parseAscii('A\\r\\n\\x01\\\\')], [0x41, 0x0d, 0x0a, 0x01, 0x5c]);
  assert.equal(parseAscii('中').length, 3); // UTF-8
  assert.throws(() => parseAscii('bad\\q'), PayloadError);
  assert.throws(() => parseAscii('x\\xZZ'), PayloadError);
  assert.throws(() => parseAscii('end\\'), PayloadError);
});

test('HEX 多种写法', () => {
  const want = [0xa5, 0x01, 0xff];
  for (const s of ['A5 01 FF', 'a501ff', '0xA5,0x01,0xFF', 'A5:01:FF', 'A5-01-FF']) {
    assert.deepEqual([...parseHex(s)], want, s);
  }
  assert.throws(() => parseHex('A5 0'), PayloadError);
  assert.throws(() => parseHex('A5 GG'), PayloadError);
  assert.equal(formatHex(Buffer.from([0xa5, 0x01])), 'A5 01');
});

test('结束符只对 ASCII 生效；空内容报错', () => {
  assert.deepEqual([...buildPayload('ascii', 'GO', 'crlf')], [0x47, 0x4f, 0x0d, 0x0a]);
  assert.deepEqual([...buildPayload('hex', 'A5', 'crlf')], [0xa5]);
  assert.throws(() => buildPayload('ascii', ''), PayloadError);
  assert.equal(describeAscii(Buffer.from('A\r\n\x01\\')), 'A\\r\\n\\x01\\\\');
});

test('匹配：ASCII 忽略末尾换行，HEX 不忽略', () => {
  const ascii = (kind: 'exact' | 'prefix' | 'contains' | 'regex', pattern: string) =>
    ({ kind, format: 'ascii' as const, pattern });
  assert.ok(matchBuffer(Buffer.from('OPEN\r\n'), ascii('exact', 'OPEN')).matched);
  assert.ok(!matchBuffer(Buffer.from('OPENX'), ascii('exact', 'OPEN')).matched);
  assert.ok(matchBuffer(Buffer.from('OPENX'), ascii('prefix', 'OPEN')).matched);
  assert.ok(matchBuffer(Buffer.from('xxOPENxx'), ascii('contains', 'OPEN')).matched);
  assert.ok(matchBuffer(Buffer.from('OK\r\n'), ascii('exact', 'OK\\r\\n')).matched); // pattern 自带换行则精确比较
  assert.ok(!matchBuffer(Buffer.from('OK'), ascii('exact', 'OK\\r\\n')).matched);
  const re = matchBuffer(Buffer.from('SCENE 12\r\n'), ascii('regex', '^SCENE (\\d+)$'));
  assert.deepEqual(re, { matched: true, captures: ['12'] });
  const hex = { kind: 'prefix' as const, format: 'hex' as const, pattern: 'A5 10' };
  assert.ok(matchBuffer(Buffer.from([0xa5, 0x10, 0x01]), hex).matched);
  assert.ok(!matchBuffer(Buffer.from([0xa5, 0x11]), hex).matched);
  assert.throws(() => matchBuffer(Buffer.from('x'), { kind: 'regex', format: 'hex', pattern: '.' }), PayloadError);
  assert.throws(() => matchBuffer(Buffer.from('x'), ascii('regex', '(')), PayloadError);
});

test('时间解析到毫秒', () => {
  assert.equal(parseTime('09:00'), 9 * 3600_000);
  assert.equal(parseTime('09:00:01.5'), 9 * 3600_000 + 1500);
  assert.equal(parseTime('23:59:59.999'), 86_399_999);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('9:60'), null);
  assert.equal(formatTime(32_401_042), '09:00:01.042');
});
