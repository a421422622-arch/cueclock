/**
 * OSC 1.0（Open Sound Control）消息生成。只用 Uint8Array，不依赖 Node，界面预览共用。
 * 编码规则（规范）：OSC-string = 非空 ASCII 字符 + 至少 1 个 0 字节，补到 4 的倍数；int32 / float32 大端；
 * 类型标签串以逗号开头；blob = int32 长度 + 数据 + 补零到 4 的倍数；T / F / N 不占数据字节。
 *
 * 文本写法（界面里「格式 = OSC」的内容框）：`地址 参数 参数 …`，参数之间空格分隔，带空格的字符串用双引号：
 *   /cue/1/start                      无参数
 *   /layer1/opacity 0.5               小数 → float；整数 → int32；其他 → 字符串
 *   /note i:60 f:0.8 s:"hello world"  用 i: f: s: b: 明确类型（b: 后跟十六进制）
 *   /toggle T                         T / F / N（或 true / false / nil）
 * 参数里可以写 {{参数名}}、$1（触发器捕获）、{{value}}（滑块），和其他内容一样先代入再编码。
 */
export type OscArg =
  | { t: 'i'; v: number }
  | { t: 'f'; v: number }
  | { t: 's'; v: string }
  | { t: 'b'; v: Uint8Array }
  | { t: 'T' }
  | { t: 'F' }
  | { t: 'N' };

export interface OscMessage { address: string; args: OscArg[] }

export class OscError extends Error {}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

/** 按空白切分，双引号内的空白保留；引号内支持 \" 和 \\。返回 [文本, 是否带引号]。 */
function tokenize(text: string): { text: string; quoted: boolean; wholeQuoted: boolean }[] {
  const out: { text: string; quoted: boolean; wholeQuoted: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue; }
    let cur = '';
    let quoted = false;
    const wholeQuoted = text[i] === '"'; // token 一开头就是引号：整个是字面字符串；否则（如 s:"…"）引号只包住值
    while (i < text.length && !/\s/.test(text[i]!)) {
      const ch = text[i]!;
      if (ch === '"') {
        quoted = true;
        i++;
        for (;;) {
          if (i >= text.length) throw new OscError('引号没有闭合');
          const c = text[i]!;
          if (c === '"') { i++; break; }
          if (c === '\\') {
            const n = text[i + 1];
            if (n !== '"' && n !== '\\') throw new OscError(`字符串里只支持 \\" 和 \\\\ 两种转义，遇到 \\${n ?? ''}`);
            cur += n;
            i += 2;
            continue;
          }
          cur += c;
          i++;
        }
        continue;
      }
      cur += ch;
      i++;
    }
    out.push({ text: cur, quoted, wholeQuoted });
  }
  return out;
}

const hexToBytes = (h: string): Uint8Array => {
  const c = h.replace(/0x/gi, '').replace(/[\s,:;-]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(c)) throw new OscError('blob 内容含有非法的十六进制字符');
  if (c.length % 2) throw new OscError('blob 的十六进制位数必须为偶数');
  return Uint8Array.from(c.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
};

function intArg(s: string): OscArg {
  if (!INT_RE.test(s)) throw new OscError(`"${s}" 不是整数`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) throw new OscError(`整数 ${s} 超出 int32 范围（-2147483648 ~ 2147483647），要发大数请用 f:`);
  return { t: 'i', v: n };
}
function floatArg(s: string): OscArg {
  if (!FLOAT_RE.test(s)) throw new OscError(`"${s}" 不是数字`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new OscError(`数字 ${s} 超出范围`);
  return { t: 'f', v: n };
}

/** 一个参数 token → 带类型的参数。无类型前缀时：带引号 → 字符串；整数 → i；小数/科学计数 → f；T/F/N/true/false/nil；其他 → 字符串。 */
function parseArg(tok: { text: string; quoted: boolean; wholeQuoted: boolean }): OscArg {
  const { text, quoted, wholeQuoted } = tok;
  if (wholeQuoted) return { t: 's', v: text };
  const typed = /^([ifsb]):(.*)$/s.exec(text);
  if (typed) {
    const [, ty, rest] = typed as unknown as [string, string, string];
    if (ty === 'i') return intArg(rest);
    if (ty === 'f') return floatArg(rest);
    if (ty === 's') return { t: 's', v: rest };
    return { t: 'b', v: hexToBytes(rest) };
  }
  if (text === 'T' || text === 'true') return { t: 'T' };
  if (text === 'F' || text === 'false') return { t: 'F' };
  if (text === 'N' || text === 'nil') return { t: 'N' };
  if (INT_RE.test(text)) return intArg(text);
  if (FLOAT_RE.test(text)) return floatArg(text);
  return { t: 's', v: text };
}

export function parseOsc(text: string): OscMessage {
  const toks = tokenize(text);
  if (toks.length === 0) throw new OscError('内容为空');
  const address = toks[0]!.text;
  if (toks[0]!.wholeQuoted || !address.startsWith('/')) throw new OscError('OSC 地址必须以 / 开头，如 /cue/1/start');
  if (!/^[\x21-\x7e]+$/.test(address) || address.includes(',')) throw new OscError('OSC 地址只能是不含空格和逗号的可见 ASCII 字符');
  return { address, args: toks.slice(1).map(parseArg) };
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

function oscString(s: string): number[] {
  const body = Array.from(new TextEncoder().encode(s));
  if (body.includes(0)) throw new OscError('字符串里不能含有空字符');
  return [...body, 0, ...new Array<number>(pad4(body.length + 1)).fill(0)];
}

export function encodeOsc(msg: OscMessage): Uint8Array {
  const out: number[] = [...oscString(msg.address), ...oscString(',' + msg.args.map((a) => a.t).join(''))];
  for (const a of msg.args) {
    if (a.t === 'i') {
      const v = new DataView(new ArrayBuffer(4));
      v.setInt32(0, a.v, false);
      out.push(...new Uint8Array(v.buffer));
    } else if (a.t === 'f') {
      const v = new DataView(new ArrayBuffer(4));
      v.setFloat32(0, a.v, false);
      if (!Number.isFinite(v.getFloat32(0, false))) throw new OscError(`数字 ${a.v} 超出 float32 范围`);
      out.push(...new Uint8Array(v.buffer));
    } else if (a.t === 's') {
      out.push(...oscString(a.v));
    } else if (a.t === 'b') {
      const size = new DataView(new ArrayBuffer(4));
      size.setInt32(0, a.v.length, false);
      out.push(...new Uint8Array(size.buffer), ...a.v, ...new Array<number>(pad4(a.v.length)).fill(0));
    }
  }
  return Uint8Array.from(out);
}

/** 文本 → OSC 字节（发送内容生成用）。 */
export const oscBytes = (text: string): Uint8Array => encodeOsc(parseOsc(text));

/** 给界面的一句话解读：地址 + 类型标签。 */
export function describeOsc(text: string): string {
  const m = parseOsc(text);
  return `${m.address}  ,${m.args.map((a) => a.t).join('')}`;
}
