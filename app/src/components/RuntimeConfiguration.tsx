import { useMemo, useState } from 'react';
import { configurationChanges } from '@engine/configuration.ts';
import { beginDraft, dismissLastApplied, refreshRuntimeConfig, runtimeVerified, showLogTab, useStore, viewingRuntime, viewRuntime } from '../store.ts';
import { Icon } from './Icon.tsx';

/** 最近一次应用的更新说明：几处变更，点开看清单。 */
export function LastApplied() {
  const last = useStore((s) => s.lastApplied);
  const [open, setOpen] = useState(false);
  if (!last) return null;
  const at = new Date(last.at).toLocaleTimeString('zh-CN', { hour12: false });
  return <span className="lastapplied">
    <button className="lastapplied-pill" aria-expanded={open} title={`${at} 已应用${last.scope ? ` ${last.scope}` : ''}，运行版本 r${last.rev}，${last.changes.length} 处变更。点击查看更新说明`} onClick={() => setOpen(!open)}>
      <Icon name="check" size={12} />已更新 r{last.rev}
    </button>
    {open && <div className="lastapplied-pop" role="dialog" aria-label="更新说明">
      <div className="lastapplied-head"><b>更新说明</b><span>{at} · 运行版本 r{last.rev}{last.scope ? ` · 只应用了${last.scope}` : ''}</span></div>
      {last.changes.length ? <ul>{last.changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="hint">没有内容变化。</p>}
      <div className="lastapplied-foot"><button onClick={() => { showLogTab('audit'); setOpen(false); }}>查看操作记录</button><button onClick={() => { setOpen(false); dismissLastApplied(); }}>知道了</button></div>
    </div>}
  </span>;
}

/**
 * 运行 / 编辑模式与状态（顶栏，全界面唯一一处）：运行 = 显示引擎回读的配置、只读；编辑 = 本机草稿。
 * 状态文字：运行时是修订号与回读核对情况，编辑时是「N 处未应用 / 无改动 / 冲突」。细节在悬停提示里。
 */
export function ModeControl() {
  const runtime = useStore(viewingRuntime);
  const snapshot = useStore((s) => s.runtimeSnapshot);
  const verified = useStore(runtimeVerified);
  const reading = useStore((s) => s.runtimeReading);
  const error = useStore((s) => s.runtimeReadError);
  const connected = useStore((s) => s.conn === 'connected');
  const running = useStore((s) => !!s.status?.engine?.running);
  const saveState = useStore((s) => s.saveState);
  const deferred = useStore((s) => !!s.deferredApply);
  const draft = useStore((s) => s.project);
  const changes = useMemo(() => (draft && snapshot ? configurationChanges(snapshot.project, draft).length : 0), [draft, snapshot]);
  const state = !connected ? '连接断开 · 仅显示上次回读缓存' : reading ? '正在从引擎读取…' : error ? `回读未核对：${error}` : !verified ? '配置已变化 · 待回读核对' : !running ? '已回读核对 · 引擎未运行' : '已回读核对';
  const tone = !connected || error ? 'bad' : reading || !verified || !running ? 'warn' : 'ok';
  const pending = saveState !== 'saved';
  const draftText = deferred ? '等动作结束后自动应用' : saveState === 'conflict' ? '冲突：引擎配置已在别处改变' : saveState === 'saving' ? '应用中…' : saveState === 'error' ? '草稿保存失败' : !pending ? '无改动' : changes > 0 ? `${changes} 处未应用` : '未应用';
  const detail = [
    runtime ? '运行：显示引擎正在运行的配置（只读）' : `编辑：本机草稿，${pending ? '有改动尚未应用' : '与引擎一致'}；时间轴与日历预览为草稿内容，须「检查并应用」才生效`,
    pending && runtime ? `草稿：${draftText}` : '',
    snapshot ? `引擎配置：${snapshot.project.name} · 修订 r${snapshot.rev}` : '引擎配置：尚未读回',
    `回读：${state}`,
    snapshot ? `读取于 ${new Date(snapshot.readAt).toLocaleString('zh-CN', { hour12: false })}` : '',
    snapshot ? `配置文件：${snapshot.file}` : '',
    snapshot ? `引擎实例：${snapshot.instanceId ?? '未知'}` : '',
  ].filter(Boolean).join('\n');
  const chipState = `${deferred ? 'saving' : saveState}${runtime && !pending ? ` ${tone}` : ''}`; // 保存状态（saved / dirty / conflict…）+ 运行视图下的回读色调
  return <div className={`configuration-view mode-control ${runtime ? 'runtime' : 'draft'}`} role="group" aria-label="运行 / 编辑" title={detail}>
    <div className="configuration-switch seg">
      <button aria-pressed={runtime} onClick={() => void viewRuntime()}><Icon name="activity" size={13} />运行</button>
      <button aria-pressed={!runtime} onClick={beginDraft}><Icon name="edit" size={13} />编辑</button>
    </div>
    <span className={`savestate mode-state ${chipState}`}>
      {runtime && !pending
        ? <span data-runtime-state>{snapshot ? `r${snapshot.rev} · ` : ''}{state}</span>
        : <>{draftText}<span hidden data-runtime-state>{state}</span></>}
    </span>
  </div>;
}

/** 页签栏右侧：最近一次更新说明 + 重新回读。模式与状态在顶栏 ModeControl。 */
export function RuntimeConfiguration() {
  const reading = useStore((s) => s.runtimeReading);
  const connected = useStore((s) => s.conn === 'connected');
  return <div className="configuration-tools" role="group" aria-label="运行配置">
    <LastApplied />
    <button className="ico configuration-refresh" aria-label="刷新运行配置" title="重新从引擎读取运行配置" disabled={!connected || reading} onClick={() => void refreshRuntimeConfig()}><Icon name="refresh" size={14} /></button>
  </div>;
}
