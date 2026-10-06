import { INTERVAL_MAX, INTERVAL_MIN, INTERVAL_PRESETS, intervalLabel, isPreset } from '../lib/interval.ts';
import { NumInput } from './fields.tsx';

/** 检测间隔选择：常用档位下拉 + 自定义（5~3600 秒）。设备编辑页和批量对话框共用。 */
export function IntervalPicker({ value, onChange }: { value: number; onChange: (sec: number) => void }) {
  return (
    <span className="row">
      <select value={isPreset(value) ? String(value) : 'custom'} onChange={(e) => onChange(e.target.value === 'custom' ? (isPreset(value) ? 45 : value) : Number(e.target.value))}>
        {INTERVAL_PRESETS.map((s) => (
          <option key={s} value={s}>每 {intervalLabel(s)}</option>
        ))}
        <option value="custom">自定义…</option>
      </select>
      {!isPreset(value) && (
        <>
          <NumInput value={value} min={INTERVAL_MIN} max={INTERVAL_MAX} width={72} onChange={(v) => onChange(v ?? 30)} />秒
        </>
      )}
    </span>
  );
}
