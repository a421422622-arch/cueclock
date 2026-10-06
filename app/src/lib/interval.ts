/** 在线检测间隔的常用档位（秒）。引擎允许 5~3600 秒的任意整数，这里只是方便选。 */
export const INTERVAL_PRESETS = [5, 10, 30, 60, 300, 600, 1800, 3600] as const;

export const INTERVAL_MIN = 5;
export const INTERVAL_MAX = 3600;

/** 把秒数写成人话：5 秒 / 1 分钟 / 1 分 30 秒 / 1 小时。 */
export function intervalLabel(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(sec / 3600);
  const rest = sec % 3600;
  return rest ? `${h} 小时 ${intervalLabel(rest)}` : `${h} 小时`;
}

export const isPreset = (sec: number): boolean => (INTERVAL_PRESETS as readonly number[]).includes(sec);

/** 估算「连续失败多少次判离线」需要多久，让用户知道间隔会怎样影响发现故障的速度。 */
export function offlineDelayLabel(intervalSec: number, offlineAfter = 3): string {
  return intervalLabel(intervalSec * offlineAfter);
}
