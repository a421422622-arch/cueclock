import { formatClock } from '@engine/time.ts';
import { applyConfiguration, closeApplyPreview, confirmNoChanges, useStore } from '../store.ts';
import { TODAY_CHANGE_LABEL } from '../lib/todayDiff.ts';
import type { TodayDiff } from '../lib/todayDiff.ts';

export function ApplyDialog() {
  const preview = useStore((s) => s.applyPreview);
  const saving = useStore((s) => s.saveState === 'saving');
  if (!preview) return null;
  const errors = preview.issues.filter((i) => i.level === 'error');
  const blocked = saving || errors.length > 0;
  const unchanged = preview.changes.length === 0;
  const running = preview.inFlight;
  return <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) closeApplyPreview(); }}>
    <div className="modal apply-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-title">
      <h3 id="apply-title">{preview.scope ? `应用${preview.scope}` : '检查并应用配置'}</h3>
      <div className="mb">
        <p className="note">{preview.scope ? `只把草稿里的${preview.scope}合进正在运行的配置，草稿里的其他改动不受影响、仍待应用。` : '将应用这次预览的草稿。'}当前配置先备份；已发出的指令无法撤回。</p>

        {running.length > 0 && <div className="apply-inflight" role="alert">
          <div className="sech">此刻正在执行 <span>{running.length} 项 · 立即应用会取消它们的后续步骤</span></div>
          <ul>{running.map((r) => <li key={r.id}>
            <b>{r.kind === 'scene' ? `场景「${r.name}」` : r.name}</b>
            <span>剩余 {r.remaining} 步{r.nextAt ? ` · 下一步 ${formatClock(r.nextAt).slice(0, 8)}` : ''}{r.manual ? ' · 手动' : ''}</span>
          </li>)}</ul>
          <p className="hint">选「等它们执行完再应用」：引擎先挂起这份配置，动作链结束后自动应用（最长等 30 分钟，期间配置在别处被改则放弃）。时间轴上的定时事件不受影响，会按新配置重排。</p>
        </div>}

        <div className="sech">变更清单 <span>基于运行版本 {preview.rev}</span></div>
        {preview.changes.length ? <ul className="apply-changes">{preview.changes.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="hint">内容与当前运行配置一致。</p>}

        <TodaySection today={preview.today} />

        <div className="sech">检查结果</div>
        {preview.issues.length ? <ul className="apply-changes">{preview.issues.map((r, i) => <li key={i} className={r.level === 'error' ? 'err' : ''}>{r.level === 'error' ? '错误' : '提示'}：{r.message}<small> {r.path}</small></li>)}</ul> : <p className="okc">静态检查通过。</p>}
        <p className="hint">配置检查通过不代表真实设备已执行。设备接管与自动暂停状态会保留。</p>
      </div>
      <div className="mf">
        <button disabled={saving} onClick={closeApplyPreview}>返回编辑</button>
        {unchanged && errors.length === 0
          ? <button className="primary" disabled={saving} onClick={confirmNoChanges}>确定</button>
          : running.length > 0
          ? <>
            <button className="danger-outline" disabled={blocked} onClick={() => void applyConfiguration(false)}>立即应用（取消上述动作）</button>
            <button className="primary" disabled={blocked} onClick={() => void applyConfiguration(true)}>{saving ? '提交中…' : '等它们执行完再应用'}</button>
          </>
          : <button className="primary" disabled={blocked} onClick={() => void applyConfiguration()}>{saving ? '应用中…' : '确认应用到运行'}</button>}
      </div>
    </div>
  </div>;
}

function TodaySection({ today }: { today: TodayDiff | null }) {
  if (!today) return <><div className="sech">今天剩余日程</div><p className="hint">无法计算（引擎未运行或连接中断）。</p></>;
  const none = !today.modes && today.changes.length === 0;
  return <>
    <div className="sech">今天剩余日程 <span>应用后还会执行 {today.remainingAfter} 个事件点（现在 {today.remainingBefore} 个）</span></div>
    {none ? <p className="okc">今天接下来的日程不受影响。</p> : <ul className="today-changes">
      {today.modes && <li className="mode"><span className="k">今日生效模式</span>{today.modes.from.join('、') || '无'} → {today.modes.to.join('、') || '无'}</li>}
      {today.changes.map((c, i) => <li key={i} className={c.kind}>
        <span className="k">{TODAY_CHANGE_LABEL[c.kind]}</span>
        <span className="n">{c.name}</span>
        <span className="t mono">{c.from && c.to ? `${c.from} → ${c.to}` : c.to ?? c.from}</span>
      </li>)}
    </ul>}
  </>;
}
