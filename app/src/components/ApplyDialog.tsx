import { applyConfiguration, closeApplyPreview, useStore } from '../store.ts';

export function ApplyDialog() {
  const preview = useStore((s) => s.applyPreview);
  const saving = useStore((s) => s.saveState === 'saving');
  if (!preview) return null;
  const errors = preview.issues.filter((i) => i.level === 'error');
  return <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) closeApplyPreview(); }}>
    <div className="modal apply-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-title">
      <h3 id="apply-title">检查并应用配置</h3>
      <div className="mb">
        <p className="note">将应用这次预览的草稿。当前配置先备份；仍在等待的旧动作链会取消，已发出的指令无法撤回。</p>
        <div className="sech">变更清单 <span>基于运行版本 {preview.rev}</span></div>
        {preview.changes.length ? <ul className="apply-changes">{preview.changes.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="hint">内容与当前运行配置一致。</p>}
        <div className="sech">检查结果</div>
        {preview.issues.length ? <ul className="apply-changes">{preview.issues.map((r, i) => <li key={i} className={r.level === 'error' ? 'err' : ''}>{r.level === 'error' ? '错误' : '提示'}：{r.message}<small> {r.path}</small></li>)}</ul> : <p className="okc">静态检查通过。</p>}
        <p className="hint">配置检查通过不代表真实设备已执行。设备接管与自动暂停状态会保留。</p>
      </div>
      <div className="mf"><button disabled={saving} onClick={closeApplyPreview}>返回编辑</button><button className="primary" disabled={saving || errors.length > 0 || preview.changes.length === 0} onClick={() => void applyConfiguration()}>{saving ? '应用中…' : '确认应用到运行'}</button></div>
    </div>
  </div>;
}
