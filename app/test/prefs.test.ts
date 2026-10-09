import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrefs } from '../electron/prefs.ts';

test('关闭按钮偏好：默认每次询问；旧版 keepInTray=true 也改为询问，明确关掉过的保留为退出界面', () => {
  assert.deepEqual(parsePrefs(undefined), { closeAction: 'ask' });
  assert.deepEqual(parsePrefs({}), { closeAction: 'ask' });
  assert.deepEqual(parsePrefs({ keepInTray: true }), { closeAction: 'ask' });
  assert.deepEqual(parsePrefs({ keepInTray: false }), { closeAction: 'quit' });
  assert.deepEqual(parsePrefs({ closeAction: 'tray', keepInTray: false }), { closeAction: 'tray' });
  assert.deepEqual(parsePrefs({ closeAction: 'bogus' }), { closeAction: 'ask' });
});
