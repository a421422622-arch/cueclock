/** 界面闲置多久自动重新上锁（毫秒）。 */
export const AUTO_LOCK_MS = 10 * 60_000;

/** 是否该自动上锁：只有「设了密码且当前已解锁」才有意义，闲置超过限制才锁。 */
export function shouldAutoLock(lock: { enabled: boolean; unlocked: boolean }, lastActivity: number, now: number, limit = AUTO_LOCK_MS): boolean {
  return lock.enabled && lock.unlocked && now - lastActivity >= limit;
}

/** 新密码校验（和引擎规则一致：4~128 个字符），返回错误提示；通过返回 null。 */
export function checkNewPassword(pw: string, confirm: string): string | null {
  if (pw.length < 4) return '密码至少 4 个字符';
  if (pw.length > 128) return '密码最多 128 个字符';
  if (pw !== confirm) return '两次输入的密码不一致';
  return null;
}

export interface BackupSummary { devices: number; timelines: number; cues: number; commands: number; scenes: number; triggers: number }

/** 备份概要的一行说明，0 的项不显示。 */
export function summaryText(s: BackupSummary): string {
  const parts: [number, string][] = [[s.devices, '设备'], [s.timelines, '模式'], [s.cues, '事件点'], [s.commands, '指令'], [s.scenes, '场景'], [s.triggers, '触发器']];
  const shown = parts.filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`);
  return shown.length ? shown.join(' · ') : '空配置';
}
