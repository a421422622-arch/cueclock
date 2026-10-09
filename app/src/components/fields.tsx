import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GROUP_COLORS } from '../lib/colors.ts';
import { Icon } from './Icon.tsx';

export function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <div className="color-field">
    <input type="color" value={value} aria-label={label} title={label} onChange={(e) => onChange(e.target.value)} />
    <span className="color-swatches">{GROUP_COLORS.map((color) => <button key={color} type="button"
      aria-label={`${label} ${color}`} aria-pressed={value.toLowerCase() === color.toLowerCase()}
      style={{ background: color }} onClick={() => onChange(color)} />)}</span>
  </div>;
}

/**
 * 不常用的设置默认收起：返回折叠开关（放在 .form 网格里，占满一行）和是否展开。
 * 只要有任何一项被设置过（setCount > 0）就保持展开，保证不会「设了却看不见」。
 */
export function useAdvanced(setCount: number, summary: string, label = '高级选项'): { shown: boolean; toggle: ReactNode } {
  const [open, setOpen] = useState(false);
  const forced = setCount > 0;
  const shown = open || forced;
  const toggle = (
    <div className="adv-toggle">
      <button type="button" className="link" aria-expanded={shown} disabled={forced} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={13} style={{ transform: shown ? undefined : 'rotate(-90deg)' }} />{label}
      </button>
      <span className="hint">{forced ? `已设置 ${setCount} 项，保持展开` : summary}</span>
    </div>
  );
  return { shown, toggle };
}

/**
 * 表单一行。hint 为纯文字时是「说明」：默认收起，聚焦这一项、悬停或点标签旁的 ⓘ 时显示，
 * 「软件设置 → 界面 → 显示全部说明」打开后常驻。hint 是元素（红字错误、绿字预览等）或以 ⚠ 开头、
 * 或传了 status 时是「状态」，一直显示。
 */
export function Field({ label, children, hint, status, modified, onReset }: {
  label: string; children: ReactNode; hint?: ReactNode; status?: boolean;
  /** 与默认值不同：标签左侧显示色条；给了 onReset 就显示「恢复默认」 */
  modified?: boolean; onReset?: () => void;
}) {
  const [pinned, setPinned] = useState(false);
  const help = !status && typeof hint === 'string' && hint !== '' && !hint.startsWith('⚠');
  return (
    <>
      <label className={`fl ${modified ? 'mod' : ''}`} title={modified ? '已改（与默认值不同）' : undefined}>
        {label}
        {help && <button type="button" className={`hint-i ${pinned ? 'on' : ''}`} aria-label={`${label}说明`} aria-pressed={pinned} title={hint as string} tabIndex={-1} onClick={() => setPinned(!pinned)}>i</button>}
      </label>
      <div className="fv">
        {children}
        {modified && onReset && <button type="button" className="link reset-default" onClick={onReset}>恢复默认</button>}
        {hint !== undefined && hint !== null && hint !== '' && <div className={`hint ${help ? `help ${pinned ? 'pinned' : ''}` : ''}`}>{hint}</div>}
      </div>
    </>
  );
}

const HINTS_KEY = 'cueclock-hints-all';
/** 「显示全部说明」：本机记住，作用于整个界面（给 html 加 class）。 */
export function hintsAll(): boolean {
  try { return localStorage.getItem(HINTS_KEY) === '1'; } catch { return false; }
}
export function setHintsAll(on: boolean): void {
  try { localStorage.setItem(HINTS_KEY, on ? '1' : '0'); } catch { /* 本次有效 */ }
  document.documentElement.classList.toggle('hints-all', on);
}
export function applyHintsPreference(): void {
  document.documentElement.classList.toggle('hints-all', hintsAll());
  applyPalette(palette());
}

/** 配色方案：calm（默认，2026-10-09 用户选定）= 蓝色强调、暂停用紫色；classic = 原琥珀色；neutral = 中性强调、只有状态用颜色。本机记住。 */
export type Palette = 'classic' | 'calm' | 'neutral';
const PALETTE_KEY = 'cueclock-palette';
export function palette(): Palette {
  try { const v = localStorage.getItem(PALETTE_KEY); return v === 'classic' || v === 'neutral' ? v : 'calm'; } catch { return 'calm'; }
}
export function applyPalette(p: Palette): void {
  if (p === 'classic') delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = p;
}
export function setPalette(p: Palette): void {
  try { localStorage.setItem(PALETTE_KEY, p); } catch { /* 本次有效 */ }
  applyPalette(p);
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  tone,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  tone?: Partial<Record<T, string>>;
}) {
  return (
    <span className="seg">
      {options.map((o) => (
        <span key={o.value} className={value === o.value ? `on ${tone?.[o.value] ?? ''}` : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </span>
      ))}
    </span>
  );
}

/** 数字输入：输入过程中允许为空/不完整，只有合法数字才提交。 */
export function NumInput({
  value,
  onChange,
  min = 0,
  max,
  width = 64,
  allowEmpty,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  width?: number;
  allowEmpty?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const bad = text !== '' && !(Number.isFinite(Number(text)) && Number(text) >= min && (max === undefined || Number(text) <= max));
  return (
    <input
      className={`num ${bad ? 'bad' : ''}`}
      style={{ width }}
      value={text}
      inputMode="numeric"
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t === '' && allowEmpty) onChange(undefined);
        else if (t !== '' && Number.isFinite(Number(t)) && Number(t) >= min && (max === undefined || Number(t) <= max)) onChange(Number(t));
      }}
      onBlur={() => setText(value === undefined ? '' : String(value))}
    />
  );
}

/** 文本输入，带校验：校验通过才提交，失败显示红框和说明。 */
export function ValidatedInput({
  value,
  onCommit,
  validate,
  mono,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  validate?: (v: string) => string | null;
  mono?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const err = validate ? validate(text) : null;
  return (
    <>
      <input
        className={`${mono ? 'mono' : ''} ${err ? 'bad' : ''}`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (!validate || !validate(e.target.value)) onCommit(e.target.value);
        }}
        onBlur={() => setText(value)}
      />
      {err && <div className="hint err">{err}</div>}
    </>
  );
}

export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
