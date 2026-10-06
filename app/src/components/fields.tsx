import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GROUP_COLORS } from '../lib/colors.ts';

export function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <div className="color-field">
    <input type="color" value={value} aria-label={label} title={label} onChange={(e) => onChange(e.target.value)} />
    <span className="color-swatches">{GROUP_COLORS.map((color) => <button key={color} type="button"
      aria-label={`${label} ${color}`} aria-pressed={value.toLowerCase() === color.toLowerCase()}
      style={{ background: color }} onClick={() => onChange(color)} />)}</span>
  </div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <>
      <label className="fl">{label}</label>
      <div className="fv">
        {children}
        {hint && <div className="hint">{hint}</div>}
      </div>
    </>
  );
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
