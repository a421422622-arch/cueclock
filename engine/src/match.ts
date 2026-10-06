import type { MatchSpec } from './types.ts';
import { PayloadError, parsePayload } from './payload.ts';

export interface MatchResult {
  matched: boolean;
  captures: string[];
}

const regexCache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new PayloadError(`正则无效：${(e as Error).message}`);
    }
    regexCache.set(pattern, re);
  }
  return re;
}

/** 去掉末尾的 \r \n（ASCII 比较时设备常带换行）。 */
function stripTrailingCrLf(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end--;
  return buf.subarray(0, end);
}

/**
 * 判断数据是否符合匹配条件。
 * ASCII 模式下，数据末尾的 \r\n 会被忽略（除非 pattern 自己以 \r 或 \n 结尾）。
 * 正则只支持 ASCII，按 latin1 解码以保持字节透明。
 */
export function matchBuffer(data: Buffer, spec: MatchSpec): MatchResult {
  const no: MatchResult = { matched: false, captures: [] };
  if (spec.kind === 'regex') {
    if (spec.format === 'hex') throw new PayloadError('正则只支持 ASCII');
    const m = compile(spec.pattern).exec(stripTrailingCrLf(data).toString('latin1'));
    return m ? { matched: true, captures: m.slice(1).map((c) => c ?? '') } : no;
  }
  const pat = parsePayload(spec.format, spec.pattern);
  if (pat.length === 0) throw new PayloadError('匹配内容为空');
  let subject = data;
  if (spec.format === 'ascii') {
    const last = pat[pat.length - 1];
    if (last !== 0x0d && last !== 0x0a) subject = stripTrailingCrLf(data);
  }
  switch (spec.kind) {
    case 'exact':
      return subject.equals(pat) ? { matched: true, captures: [] } : no;
    case 'prefix':
      return subject.length >= pat.length && subject.subarray(0, pat.length).equals(pat)
        ? { matched: true, captures: [] }
        : no;
    case 'contains':
      return subject.indexOf(pat) >= 0 ? { matched: true, captures: [] } : no;
  }
}
