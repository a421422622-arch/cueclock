import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleFileName, parseBundleText } from '../src/lib/bundleFile.ts';

test('备份包文件名：去掉文件名里不能用的字符、带日期时间、保持扩展名', () => {
  const d = new Date(2026, 9, 7, 8, 5);
  assert.equal(bundleFileName('东侧展厅 / 灯光:投影?', d), '东侧展厅_灯光_投影-20261007-0805.cueclock-bundle.json');
  assert.equal(bundleFileName('   ', d), 'cueclock-20261007-0805.cueclock-bundle.json');
  assert(bundleFileName('长'.repeat(100), d).startsWith('长'.repeat(40) + '-'));
});

test('读备份包文件：不是 JSON、不是对象都给清楚的原因', () => {
  assert.throws(() => parseBundleText('not json'), /不是有效的 JSON/);
  assert.throws(() => parseBundleText('[1,2]'), /不是备份包/);
  assert.throws(() => parseBundleText('"x"'), /不是备份包/);
  assert.deepEqual(parseBundleText('{"format":"x"}'), { format: 'x' });
});
