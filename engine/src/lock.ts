import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 编辑锁的密码记录：只存加盐哈希，绝不存明文。放在机器级 settings.json，不进配置文件。 */
export interface LockRecord {
  salt: string;
  hash: string;
}

export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 128;
export const MAX_ATTEMPTS = 5;
export const DEFAULT_LOCKOUT_MS = 30_000;

const KEYLEN = 32;

export function hashPassword(password: string): LockRecord {
  const salt = randomBytes(16);
  return { salt: salt.toString('hex'), hash: scryptSync(password, salt, KEYLEN).toString('hex') };
}

export function verifyPassword(password: string, rec: LockRecord): boolean {
  const got = scryptSync(password, Buffer.from(rec.salt, 'hex'), KEYLEN);
  const want = Buffer.from(rec.hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export const isLockRecord = (v: unknown): v is LockRecord =>
  typeof v === 'object' && v !== null && typeof (v as LockRecord).salt === 'string' && typeof (v as LockRecord).hash === 'string' &&
  /^[0-9a-f]+$/i.test((v as LockRecord).salt) && /^[0-9a-f]+$/i.test((v as LockRecord).hash);

/**
 * 锁定状态下仍然放行的方法：查看，以及急停/恢复（急停是安全开关，不该被密码挡住）。
 * 其余一律需要先解锁——**默认拒绝**，以后新增的写方法自动受保护。
 */
export const LOCKED_ALLOWED = new Set([
  'ping', 'status', 'getProject', 'getLogs', 'getAlerts', 'getSettings', 'getRuntimeOptions', 'getNetwork', 'listInterfaces', 'listBackups',
  'validateProject', 'previewProject', 'simulate', 'pause', 'resume', 'lockStatus', 'unlock', 'lock',
  // 只读：检测记录、操作记录、备份包导出与预览（预览不写任何东西）
  'getProbeHistory', 'getAudit', 'exportBundle', 'previewBundle', 'listLogDays', 'readLogDay',
  // 操作面板：配置锁定后，现场操作员仍然可以点按钮（这正是「配置上锁、面板可用」的用法）
  'runPadTile', 'resetPadState', 'setDeviceOverride', 'cancelScene',
]);

/** 忘记密码时用：清除 settings.json 里的锁。需要本机文件权限（和能直接改配置文件同一信任级别）。返回之前是否有锁。 */
export async function resetLock(stateDir: string): Promise<boolean> {
  const file = path.join(stateDir, 'settings.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!('lock' in raw)) return false;
  delete raw.lock;
  await writeFile(file, JSON.stringify(raw, null, 2));
  return true;
}
