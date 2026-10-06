export const DAY_MS = 86_400_000;

/** "HH:MM[:SS[.mmm]]" → 当天毫秒数；非法返回 null */
export function parseTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = m[3] === undefined ? 0 : Number(m[3]);
  const ms = m[4] === undefined ? 0 : Number(m[4].padEnd(3, '0'));
  if (h > 23 || mi > 59 || se > 59) return null;
  return ((h * 60 + mi) * 60 + se) * 1000 + ms;
}

export function formatTime(msOfDay: number): string {
  const ms = Math.floor(msOfDay % 1000);
  const total = Math.floor(msOfDay / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}.${p(ms, 3)}`;
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
