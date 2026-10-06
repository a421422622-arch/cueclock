import type { DeviceFeedbackConfig } from './types.ts';

/** 只由已校验的设备回包调用；捕获内容始终是文本，不参与指令展开。 */
export function readFeedback(config: DeviceFeedbackConfig, reply: Buffer): Record<string, string> | null {
  if (reply.length > 4096) return null;
  try {
    const text = config.format === 'hex' ? reply.toString('hex').toUpperCase() : reply.toString('latin1').replace(/[\r\n]+$/, '');
    const m = new RegExp(config.pattern).exec(text);
    if (!m) return null;
    const fields = config.fields.map((f) => [f.label, m[f.group]] as const);
    if (fields.some(([, value]) => value === undefined)) return null;
    return Object.fromEntries(fields) as Record<string, string>;
  } catch { return null; }
}
