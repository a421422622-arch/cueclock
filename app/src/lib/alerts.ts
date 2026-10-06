import type { AlertCode, LogEntry } from '../../../engine/src/engine.ts';

export const ALERT_LABEL: Record<AlertCode, string> = {
  'reply-timeout': '回包超时',
  'reply-mismatch': '回包不符',
  'send-error': '发送失败',
  'device-offline': '设备离线',
  'device-online': '设备恢复',
  'events-missed': '错过事件',
  'trigger-rejected': '触发被拒',
  'network-missing': '网卡不可用',
  'network-restored': '网卡恢复',
  paused: '已急停',
  resumed: '已恢复调度',
  'scheduler-error': '调度错误',
  'internal-error': '内部错误',
  'engine-start-failed': '引擎启动失败',
};

const keyOf = (e: LogEntry) => `${e.t}|${e.alert?.code}|${e.alert?.subject ?? ''}|${e.detail ?? ''}`;

/** 历史告警（磁盘）+ 本次运行里实时收到的告警，去重后按时间升序。 */
export function mergeAlerts(history: LogEntry[], live: LogEntry[]): LogEntry[] {
  const seen = new Map<string, LogEntry>();
  for (const e of [...history, ...live]) if (e.alert) seen.set(keyOf(e), e);
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

/** 需要留意的新告警数：warn/error 级别，且发生在上次查看之后。info（恢复类）不计。 */
export function unseenCount(alerts: LogEntry[], seenAt: number): { count: number; hasError: boolean } {
  let count = 0;
  let hasError = false;
  for (const a of alerts) {
    if (a.t <= seenAt || !a.alert || a.alert.level === 'info') continue;
    count++;
    if (a.alert.level === 'error') hasError = true;
  }
  return { count, hasError };
}
