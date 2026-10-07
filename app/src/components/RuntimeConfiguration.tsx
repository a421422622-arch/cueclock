import { beginDraft, refreshRuntimeConfig, runtimeVerified, useStore, viewingRuntime, viewRuntime } from '../store.ts';
import { Icon } from './Icon.tsx';

/** 身份和内容均来自引擎；断线缓存与未核对状态必须显式显示。放在视图页签栏右侧，细节在悬停提示里。 */
export function RuntimeConfiguration() {
  const runtime = useStore(viewingRuntime);
  const snapshot = useStore((s) => s.runtimeSnapshot);
  const verified = useStore(runtimeVerified);
  const reading = useStore((s) => s.runtimeReading);
  const error = useStore((s) => s.runtimeReadError);
  const connected = useStore((s) => s.conn === 'connected');
  const running = useStore((s) => !!s.status?.engine?.running);
  const dirty = useStore((s) => s.saveState !== 'saved');
  const state = !connected ? '连接断开 · 仅显示上次回读缓存' : reading ? '正在从引擎读取…' : error ? `回读未核对：${error}` : !verified ? '配置已变化 · 待回读核对' : !running ? '已回读核对 · 引擎未运行' : '已回读核对';
  const tone = !connected || error ? 'bad' : reading || !verified || !running ? 'warn' : 'ok';
  const detail = [
    runtime ? '当前显示：引擎配置（只读）' : `当前显示：本机草稿（${dirty ? '尚未应用' : '与引擎一致'}）；时间轴与日历预览为草稿内容，须「检查并应用」才生效`,
    snapshot ? `引擎配置：${snapshot.project.name} · 修订 r${snapshot.rev}` : '引擎配置：尚未读回',
    `状态：${state}`,
    snapshot ? `读取于 ${new Date(snapshot.readAt).toLocaleString('zh-CN', { hour12: false })}` : '',
    snapshot ? `配置文件：${snapshot.file}` : '',
    snapshot ? `引擎实例：${snapshot.instanceId ?? '未知'}` : '',
  ].filter(Boolean).join('\n');
  return <div className={`configuration-view ${runtime ? 'runtime' : 'draft'}`} role="group" aria-label="配置来源" title={detail}>
    <div className="configuration-switch seg">
      <button aria-pressed={runtime} onClick={() => void viewRuntime()}><Icon name="activity" size={13} />查看正在运行</button>
      <button aria-pressed={!runtime} onClick={beginDraft}><Icon name="edit" size={13} />编辑草稿</button>
    </div>
    <span className={`configuration-state ${runtime ? tone : 'draft'}`}>
      <i />
      {runtime
        ? <span data-runtime-state>{snapshot ? `r${snapshot.rev} · ` : ''}{state}</span>
        : <span>{dirty ? '草稿未应用' : '草稿'}<span hidden data-runtime-state>{state}</span></span>}
    </span>
    <button className="ico configuration-refresh" aria-label="刷新运行配置" title="重新从引擎读取运行配置" disabled={!connected || reading} onClick={() => void refreshRuntimeConfig()}><Icon name="refresh" size={14} /></button>
  </div>;
}
