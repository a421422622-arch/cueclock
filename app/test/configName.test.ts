import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configName } from '../src/lib/configName.ts';

test('配置显示名：去掉 .cueclock.json / .json，兼容 Windows 路径，不露出 JSON', () => {
  assert.equal(configName('/Users/a/CueClock/展厅.cueclock.json'), '展厅');
  assert.equal(configName('C:\\Users\\a\\default.cueclock.json'), 'default');
  assert.equal(configName('/x/backup.JSON'), 'backup');
  assert.equal(configName('/x/no-extension'), 'no-extension');
  assert.equal(configName('/x/.json'), '.json'); // 全是后缀时保留原名，不返回空串
  assert.equal(configName(null), '（未知）');
});
