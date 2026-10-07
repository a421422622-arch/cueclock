import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oscBytes, parseOsc, describeOsc, OscError } from '../src/osc.ts';
import { buildPayload } from '../src/payload.ts';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

test('无参数：地址与类型标签串都补零到 4 的倍数（"/a" 3 字节 → 4；"," → 4）', () => {
  assert.equal(hex(oscBytes('/a')), '2f610000' + '2c000000');
  assert.equal(hex(oscBytes('/abc')), '2f616263' + '00000000' + '2c000000'); // 4 字节地址还要再补 4 个零（至少 1 个空字符）
});

test('整数 / 小数 / 显式类型：大端 int32、IEEE754 float32', () => {
  assert.equal(hex(oscBytes('/a 1')), '2f610000' + '2c690000' + '00000001');
  assert.equal(hex(oscBytes('/a -1')), '2f610000' + '2c690000' + 'ffffffff');
  assert.equal(hex(oscBytes('/a 0.5')), '2f610000' + '2c660000' + '3f000000');
  assert.equal(hex(oscBytes('/a f:440')), '2f610000' + '2c660000' + '43dc0000');
  assert.equal(hex(oscBytes('/a 5.0')), '2f610000' + '2c660000' + '40a00000');
  assert.equal(hex(oscBytes('/a f:1e3')), '2f610000' + '2c660000' + '447a0000');
  assert.equal(hex(oscBytes('/a i:7 f:1')), '2f610000' + '2c696600' + '00000007' + '3f800000');
});

test('字符串：补零；带空格要加引号；s: 强制字符串；裸单词也是字符串', () => {
  assert.equal(hex(oscBytes('/a hi')), '2f610000' + '2c730000' + '68690000');
  assert.equal(hex(oscBytes('/a "hi there"')), '2f610000' + '2c730000' + Buffer.from('hi there\0\0\0\0').toString('hex')); // 8 字节 + 4 个零
  assert.equal(hex(oscBytes('/a s:5')), '2f610000' + '2c730000' + '35000000');
  assert.equal(hex(oscBytes('/a "say \\"x\\""')), '2f610000' + '2c730000' + Buffer.from('say "x"\0').toString('hex'));
});

test('类型前缀 + 引号：s:"hi there" 是字符串 hi there（不带 s:）；整个 token 加引号则是字面字符串', () => {
  assert.equal(hex(oscBytes('/a s:"hi there"')), hex(oscBytes('/a "hi there"')));
  assert.equal(hex(oscBytes('/a b:"DE AD"')), hex(oscBytes('/a b:DEAD')));
  assert.equal(hex(oscBytes('/a i:"7"')), hex(oscBytes('/a i:7')));
  assert.deepEqual(parseOsc('/a "s:5"').args, [{ t: 's', v: 's:5' }]); // 整个 token 加引号 = 字面字符串，不解释前缀
  assert.deepEqual(parseOsc('/a "5"').args, [{ t: 's', v: '5' }]);
});

test('blob：长度 + 数据 + 补零；T / F / N 不占数据字节', () => {
  assert.equal(hex(oscBytes('/a b:DEADBEEF')), '2f610000' + '2c620000' + '00000004' + 'deadbeef');
  assert.equal(hex(oscBytes('/a b:DEAD')), '2f610000' + '2c620000' + '00000002' + 'dead0000');
  assert.equal(hex(oscBytes('/a T F N')), '2f610000' + '2c54464e' + '00000000');
  assert.equal(hex(oscBytes('/a true false nil')), hex(oscBytes('/a T F N')));
});

test('综合：地址 23 字符（+1 个空字符正好 24 字节，不多补）', () => {
  const b = oscBytes('/oscillator/4/frequency f:440');
  assert.equal(hex(b), Buffer.from('/oscillator/4/frequency\0').toString('hex') + '2c660000' + '43dc0000');
  assert.equal(b.length % 4, 0);
});

test('错误：缺 /、空内容、越界、非法 hex、未闭合引号、非法字符都有明确中文原因', () => {
  const bad = (t: string, re: RegExp) => assert.throws(() => oscBytes(t), (e: Error) => e instanceof OscError && re.test(e.message), t);
  bad('', /内容为空/);
  bad('cue/1', /以 \/ 开头/);
  bad('"/a" 1', /以 \/ 开头/);
});

test('错误（续）', () => {
  const bad = (t: string, re: RegExp) => assert.throws(() => oscBytes(t), (e: Error) => e instanceof OscError && re.test(e.message), t);
  bad('/a 2147483648', /超出 int32/);
  bad('/a i:1.5', /不是整数/);
  bad('/a f:abc', /不是数字/);
  bad('/a f:1e999', /超出范围/);
  bad('/a f:1e39', /超出 float32/);
  bad('/a b:ABC', /位数必须为偶数/);
  bad('/a b:XY', /非法的十六进制/);
  bad('/a "abc', /引号没有闭合/);
  bad('/a "a\\nb"', /只支持/);
  bad('/a,b', /不含空格和逗号/);
  bad('/中文', /可见 ASCII/);
});

test('解析：类型推断与显式类型；describeOsc 给出地址和类型串', () => {
  assert.deepEqual(parseOsc('/x 1 2.5 "a b" T').args.map((a) => a.t), ['i', 'f', 's', 'T']);
  assert.equal(describeOsc('/x 1 2.5 "a b" T'), '/x  ,ifsT');
});

test('buildPayload：format=osc 生成 OSC 字节，不追加结束符', () => {
  assert.equal(hex(buildPayload('osc', '/a 1', 'crlf')), '2f610000' + '2c690000' + '00000001');
  assert.throws(() => buildPayload('osc', ''), /内容为空/);
});
