import { useState } from 'react';
import { RpcFailure } from '../transport.ts';
import { isLocked, openUnlock, protectDraft, rpc, toast, useStore } from '../store.ts';
import { BUNDLE_MAX_BYTES, bundleFileName, parseBundleText } from '../lib/bundleFile.ts';

interface Preview {
  createdAt: string; from?: { engineVersion?: string; platform?: string };
  projectName: string; counts: { devices: number; commands: number; scenes: number; pads: number; tiles: number; timelines: number; cues: number; triggers: number };
  changes: string[]; issues: { level: string; message: string; path: string }[]; warnings: string[];
  settings: { network: { localAddresses?: string[]; localPort?: number } | null; preventSleep: boolean; healthPaused: boolean };
  current: { projectName: string; network: unknown; preventSleep: boolean; healthPaused: boolean };
  auditCount: number; logCount: number;
}

/** 导出：下载一个备份包文件（项目 + 机器设置 + 诊断信息）。 */
export async function exportBundle(): Promise<void> {
  try {
    const bundle = await rpc<{ project: { name: string } }>('exportBundle');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    a.download = bundleFileName(bundle.project.name);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(`已导出备份包：${a.download}（在「下载」文件夹）`);
  } catch (e) { toast(`导出失败：${e instanceof RpcFailure ? e.message : String(e)}`); }
}

/** 从备份包恢复：选文件 → 引擎预览差异 → 确认后还原（先强制备份当前配置）。 */
export function BundleRestore() {
  const [preview, setPreview] = useState<{ bundle: unknown; p: Preview; name: string } | null>(null);
  const [applyNetwork, setApplyNetwork] = useState(false);
  const [applyRuntime, setApplyRuntime] = useState(true);
  const [busy, setBusy] = useState(false);
  const dirty = useStore((s) => s.saveState !== 'saved');
  const connected = useStore((s) => s.conn === 'connected');

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (isLocked()) { openUnlock(); toast('编辑已锁定：请先解锁再还原'); return; }
    if (file.size > BUNDLE_MAX_BYTES) { toast('文件太大，不像是备份包'); return; }
    setBusy(true);
    try {
      const bundle = parseBundleText(await file.text());
      const p = await rpc<Preview>('previewBundle', { bundle });
      setApplyNetwork(false); setApplyRuntime(true);
      setPreview({ bundle, p, name: file.name });
    } catch (e) { toast(`读取备份包失败：${e instanceof RpcFailure ? e.message : (e as Error).message}`); }
    setBusy(false);
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      protectDraft(); // 还原会换掉当前配置：本机未应用的草稿先存好，不会丢
      const r = await rpc<{ rev: number; networkApplied: boolean; runtimeApplied: boolean }>('applyBundle', { bundle: preview.bundle, applyNetwork, applyRuntime });
      toast(`已从备份包还原「${preview.p.projectName}」（r${r.rev}）${r.networkApplied ? '，网络设置已还原、引擎已重启' : ''}`);
      setPreview(null);
    } catch (e) { toast(`还原失败：${e instanceof RpcFailure ? e.message : String(e)}`); }
    setBusy(false);
  };

  const errors = preview?.p.issues.filter((i) => i.level === 'error') ?? [];
  const c = preview?.p.counts;
  return <>
    <label className={`filebtn ${busy || !connected ? 'disabled' : ''}`}>
      从备份包恢复…
      <input type="file" accept=".json,application/json" disabled={busy || !connected} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
    {preview && <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setPreview(null); }}>
      <div className="modal bundle-dialog" role="dialog" aria-modal="true" aria-labelledby="bundle-title">
        <h3 id="bundle-title">从备份包还原</h3>
        <div className="mb">
          <div className="bundle-summary">
            <div><small>备份包</small><b title={preview.name}>{preview.name}</b></div>
            <div><small>项目</small><b title={preview.p.projectName}>{preview.p.projectName}</b></div>
            <div><small>生成时间</small><b>{new Date(preview.p.createdAt).toLocaleString('zh-CN', { hour12: false })}</b></div>
            <div><small>来源</small><b>{preview.p.from?.engineVersion ?? '未知'} · {preview.p.from?.platform ?? ''}</b></div>
          </div>
          {c && <p className="hint">包含：{c.devices} 台设备、{c.commands} 条指令、{c.scenes} 个场景、{c.timelines} 个模式（{c.cues} 个事件点）、{c.pads} 个面板（{c.tiles} 个按钮）、{c.triggers} 个触发器；另有 {preview.p.logCount} 条日志和 {preview.p.auditCount} 条操作记录供查阅。</p>}
          <p className="note">还原会<b>替换当前正在运行的配置</b>「{preview.p.current.projectName}」。还原前先自动备份当前配置，可以从「从备份恢复」里回到现在的样子。</p>
          {dirty && <p className="note warn">你有尚未应用的本机草稿：它会保留在本机，还原后可以在提示里恢复，但可能和新配置冲突。</p>}
          {preview.p.warnings.map((w, i) => <p key={i} className="note warn">{w}</p>)}
          {errors.length > 0 && <ul className="apply-changes">{errors.map((i, k) => <li key={k} className="err">错误：{i.message}<small> {i.path}</small></li>)}</ul>}
          <div className="sech">相对当前配置的变化 <span>{preview.p.changes.length} 项</span></div>
          {preview.p.changes.length ? <ul className="apply-changes">{preview.p.changes.slice(0, 30).map((r, i) => <li key={i}>{r}</li>)}{preview.p.changes.length > 30 && <li className="hint">…另有 {preview.p.changes.length - 30} 项</li>}</ul> : <p className="hint">和当前配置内容一致。</p>}
          <div className="sech">机器设置（可选）</div>
          <label className="check"><input type="checkbox" checked={applyRuntime} onChange={(e) => setApplyRuntime(e.target.checked)} />同时还原运行选项：防止电脑休眠「{preview.p.settings.preventSleep ? '开' : '关'}」、后台在线检测「{preview.p.settings.healthPaused ? '暂停' : '运行'}」</label>
          <label className="check"><input type="checkbox" checked={applyNetwork} disabled={!preview.p.settings.network} onChange={(e) => setApplyNetwork(e.target.checked)} />同时还原本机网络设置：{preview.p.settings.network ? `网卡 ${(preview.p.settings.network.localAddresses ?? []).join('、') || '自动'}${preview.p.settings.network.localPort ? `，本机端口 ${preview.p.settings.network.localPort}` : ''}（还原会重启引擎）` : '备份包里没有（用的是项目里的设置）'}</label>
          <p className="hint">备份包不含编辑锁密码，新机器上需要重新设置。设备接管、面板亮灯是运行时状态，也不包含。</p>
        </div>
        <div className="mf">
          <button disabled={busy} onClick={() => setPreview(null)}>取消</button>
          <button className="primary" disabled={busy || errors.length > 0} onClick={() => void apply()}>{busy ? '还原中…' : '确认还原'}</button>
        </div>
      </div>
    </div>}
  </>;
}
