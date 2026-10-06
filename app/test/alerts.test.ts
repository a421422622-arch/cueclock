import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_LABEL, mergeAlerts, unseenCount } from '../src/lib/alerts.ts';
import type { LogEntry } from '../../engine/src/engine.ts';

const al = (t: number, code: NonNullable<LogEntry['alert']>['code'], level: 'info' | 'warn' | 'error', detail = ''): LogEntry =>
  ({ t, dir: 'SYS', result: 'info', detail, alert: { code, level } });

test('合并历史与实时告警：去重、丢掉非告警行、按时间升序', () => {
  const dup = al(2, 'paused', 'warn', 'x');
  const merged = mergeAlerts([al(1, 'device-offline', 'error', 'a'), dup], [dup, { t: 3, dir: 'TX', result: 'sent' }, al(4, 'resumed', 'info')]);
  assert.deepEqual(merged.map((m) => m.t), [1, 2, 4]);
});

test('新告警计数：只数上次查看之后的 warn/error；恢复类(info)不计；有 error 时标红', () => {
  const list = [al(10, 'device-offline', 'error'), al(20, 'paused', 'warn'), al(30, 'resumed', 'info'), al(40, 'device-online', 'info')];
  assert.deepEqual(unseenCount(list, 0), { count: 2, hasError: true });
  assert.deepEqual(unseenCount(list, 10), { count: 1, hasError: false });
  assert.deepEqual(unseenCount(list, 99), { count: 0, hasError: false });
});

test('每种告警类型都有中文名（界面不会显示英文代码）', () => {
  for (const code of ['reply-timeout', 'reply-mismatch', 'send-error', 'device-offline', 'device-online', 'events-missed', 'trigger-rejected', 'network-missing', 'network-restored', 'paused', 'resumed', 'scheduler-error', 'internal-error', 'engine-start-failed'] as const) {
    assert.ok(/[一-龥]/.test(ALERT_LABEL[code]), code);
  }
});
