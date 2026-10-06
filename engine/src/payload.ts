import type { PayloadFormat, Terminator } from './types.ts';

export class PayloadError extends Error {}

const TERMINATORS: Record<Terminator, Buffer> = {
  none: Buffer.alloc(0),
  cr: Buffer.from([0x0d]),
  lf: Buffer.from([0x0a]),
  crlf: Buffer.from([0x0d, 0x0a]),
};

/** ASCII 文本，支持转义 \r \n \t \0 \\ \xHH，其余按 UTF-8 编码。 */
export function parseAscii(text: string): Buffer {
  const parts: Buffer[] = [];
  let lit = '';
  const flush = () => {
    if (lit) {
      parts.push(Buffer.from(lit, 'utf8'));
      lit = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== '\\') {
      lit += ch;
      i++;
      continue;
    }
    const n = text[i + 1];
    if (n === undefined) throw new PayloadError('末尾的反斜杠不完整');
    flush();
    if (n === 'x') {
      const h = text.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new PayloadError(`\\x 后需要两位十六进制：\\x${h}`);
      parts.push(Buffer.from([parseInt(h, 16)]));
      i += 4;
      continue;
    }
    const map: Record<string, number> = { r: 0x0d, n: 0x0a, t: 0x09, '0': 0x00, '\\': 0x5c };
    const b = map[n];
    if (b === undefined) throw new PayloadError(`未知转义 \\${n}`);
    parts.push(Buffer.from([b]));
    i += 2;
  }
  flush();
  return Buffer.concat(parts);
}

/** HEX 文本：接受 "A5 01 FF"、"A501FF"、"0xA5,0x01"、"A5:01"。 */
export function parseHex(text: string): Buffer {
  const cleaned = text.replace(/0x/gi, '').replace(/[\s,;:-]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new PayloadError('HEX 内容含有非法字符');
  if (cleaned.length % 2 !== 0) throw new PayloadError('HEX 位数必须为偶数');
  return Buffer.from(cleaned, 'hex');
}

export function formatHex(buf: Buffer): string {
  return [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** 字节 → 可读 ASCII，不可见字符用转义显示。 */
export function describeAscii(buf: Buffer): string {
  let out = '';
  for (const b of buf) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x09) out += '\\t';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function parsePayload(format: PayloadFormat, text: string): Buffer {
  return format === 'hex' ? parseHex(text) : parseAscii(text);
}

/** 构造要发送的字节。结束符只对 ASCII 生效。 */
export function buildPayload(format: PayloadFormat, text: string, terminator: Terminator = 'none'): Buffer {
  const body = parsePayload(format, text);
  const out = format === 'ascii' ? Buffer.concat([body, TERMINATORS[terminator]]) : body;
  if (out.length === 0) throw new PayloadError('发送内容为空');
  return out;
}
