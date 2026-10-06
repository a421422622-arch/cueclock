import type { Action, PadTile } from './types.ts';

/** 滑块的取值范围，缺省 0~100、步长 1。 */
export function sliderRange(t: Pick<PadTile, 'min' | 'max' | 'step' | 'initial'>): { min: number; max: number; step: number; initial: number } {
  const min = t.min ?? 0;
  const max = t.max ?? 100;
  const step = t.step ?? 1;
  const initial = Math.min(max, Math.max(min, t.initial ?? min));
  return { min, max, step, initial };
}

const decimalsOf = (n: number): number => {
  const s = String(n);
  if (/e-/i.test(s)) return Math.min(10, Number(s.split(/e-/i)[1]));
  return s.includes('.') ? s.split('.')[1]!.length : 0;
};

/** 档位数：从 min 起每 step 一档，最后一档停在 max（max 不在步长上时多一个尾档）。 */
export const sliderSteps = (t: Pick<PadTile, 'min' | 'max' | 'step' | 'initial'>): number => {
  const { min, max, step } = sliderRange(t);
  return Math.ceil(Number(((max - min) / step).toFixed(9)));
};

/** 第 i 档对应的值（0 ≤ i ≤ sliderSteps）。 */
export function sliderValueAt(t: Pick<PadTile, 'min' | 'max' | 'step' | 'initial'>, i: number): number {
  const { min, max, step } = sliderRange(t);
  const dec = Math.max(decimalsOf(step), decimalsOf(min));
  return Math.min(max, Math.max(min, Number((min + i * step).toFixed(dec))));
}

/** 把请求的值吸附到最近的档位（含停在 max 的尾档），并限制在范围内、消除浮点尾巴。不是有限数字时抛错。 */
export function snapSliderValue(t: Pick<PadTile, 'min' | 'max' | 'step' | 'initial'>, raw: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('滑块的值必须是数字');
  const { min, max, step } = sliderRange(t);
  const clamped = Math.min(max, Math.max(min, raw));
  const pos = (clamped - min) / step;
  const lo = sliderValueAt(t, Math.floor(pos + 1e-9));
  const hi = sliderValueAt(t, Math.ceil(pos - 1e-9));
  return clamped - lo < hi - clamped ? lo : hi;
}

/** 界面档位值映射到设备值；反向范围可用于反相控制。 */
export function sliderOutput(tile: PadTile, value: number): number {
  const v = snapSliderValue(tile, value);
  if (!tile.mapping) return v;
  const { min, max } = sliderRange(tile);
  const mapping = tile.mapping;
  const result = mapping.min + (v - min) / (max - min) * (mapping.max - mapping.min);
  return Number(result.toFixed(mapping.precision ?? 0));
}

const TOKEN = /\{\{\s*(value|hex)\s*\}\}/g;

/** 文本里有没有 {{value}} / {{hex}}。 */
export const usesSliderValue = (text: string): { value: boolean; hex: boolean } => {
  const names = new Set([...text.matchAll(TOKEN)].map((m) => m[1]));
  return { value: names.has('value'), hex: names.has('hex') };
};

/** {{hex}}：整数的十六进制大写，补成偶数位（HEX 内容要求整字节）。负数、小数没有意义，抛错。 */
export function hexOf(v: number): string {
  if (!Number.isInteger(v) || v < 0) throw new Error(`{{hex}} 只能用于非负整数（当前值 ${v}）`);
  const h = v.toString(16).toUpperCase();
  return h.length % 2 ? `0${h}` : h;
}

function fill(text: string, v: number): string {
  return text.replace(TOKEN, (_a, name: string) => (name === 'hex' ? hexOf(v) : String(v)));
}

/** 取动作里会被代入的文本：自定义 UDP 的内容、指令动作的参数值。 */
export function sliderTexts(a: Action): string[] {
  if (a.type === 'udp') return [a.payload];
  if (a.type === 'command') return Object.values(a.args ?? {});
  return [];
}

/** 把 {{value}} / {{hex}} 代入动作。只处理自定义 UDP 内容与指令参数；值是校验过的数字，不会带入转义或控制字符。 */
export function substituteSliderAction(a: Action, v: number): Action {
  if (a.type === 'udp') return { ...a, payload: fill(a.payload, v) };
  if (a.type === 'command') return { ...a, args: Object.fromEntries(Object.entries(a.args ?? {}).map(([k, x]) => [k, fill(x, v)])) };
  return a;
}
