import type { EngineUpdate } from '../../engine/src/version.ts';

/** 旧引擎期间仍然放行的只读/安全方法（含急停，急停是安全开关）。 */
export const READ_ONLY_METHODS = new Set([
  'ping', 'status', 'getProject', 'getLogs', 'getSettings', 'getNetwork', 'listInterfaces', 'validateProject', 'simulate', 'pause', 'resume',
]);

/**
 * 协议或功能版本不兼容时拦截写操作：此时界面和引擎说的"话"对不上，写进去可能出错。
 * 协议和功能版本相同、只是构建不同（引擎还没加载最新修复），照常使用，界面只提示建议重启——
 * 现场有日程在跑时，不能因为"版本戳不同"就连保存配置都不行。
 */
export function isBlockedByVersion(method: string, update: EngineUpdate | null): boolean {
  if (!update || update.compatible) return false;
  return !READ_ONLY_METHODS.has(method);
}
