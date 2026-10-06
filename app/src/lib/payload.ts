// 界面里的发送内容预览（浏览器侧轻量实现，不依赖 Node 的 Buffer）。
// 真正发送前，引擎会用自己的实现再校验一遍，两边规则保持一致。

export type Terminator = 'none' | 'cr' | 'lf' | 'crlf';

export interface Preview {
  ok: boolean;
  bytes: number[];
  error?: string;
}

const TERM: Record<Terminator, number[]> = { none: [], cr: [0x0d], lf: [0x0a], crlf: [0x0d, 0x0a] };

function asciiBytes(text: string): number[] {
  const out: number[] = [];
  const enc = new TextEncoder();
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== '\\') {
      const cp = text.codePointAt(i)!;
      const s = String.fromCodePoint(cp);
      out.push(...enc.encode(s));
      i += s.length;
      continue;
    }
    const n = text[i + 1];
    if (n === undefined) throw new Error('末尾的反斜杠不完整');
    if (n === 'x') {
      const h = text.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new Error(`\\x 后需要两位十六进制：\\x${h}`);
      out.push(parseInt(h, 16));
      i += 4;
      continue;
    }
    const map: Record<string, number> = { r: 13, n: 10, t: 9, '0': 0, '\\': 92 };
    const b = map[n];
    if (b === undefined) throw new Error(`未知转义 \\${n}`);
    out.push(b);
    i += 2;
  }
  return out;
}

function hexBytes(text: string): number[] {
  const cleaned = text.replace(/0x/gi, '').replace(/[\s,;:-]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error('HEX 内容含有非法字符');
  if (cleaned.length % 2 !== 0) throw new Error('HEX 位数必须为偶数');
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) out.push(parseInt(cleaned.slice(i, i + 2), 16));
  return out;
}

export function previewPayload(format: 'ascii' | 'hex', text: string, terminator: Terminator = 'none'): Preview {
  try {
    const body = format === 'hex' ? hexBytes(text) : asciiBytes(text);
    const bytes = format === 'ascii' ? [...body, ...TERM[terminator]] : body;
    if (bytes.length === 0) return { ok: false, bytes, error: '内容为空' };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, bytes: [], error: (e as Error).message };
  }
}

export const toHex = (bytes: number[]) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
