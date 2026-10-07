import { beginDraft, refreshRuntimeConfig, runtimeVerified, useStore, viewingRuntime, viewRuntime } from '../store.ts';

/** 身份和内容均来自引擎；断线缓存与未核对状态必须显式显示。 */
export function RuntimeConfiguration() {
  const runtime = useStore(viewingRuntime);
  const snapshot = useStore((s) => s.runtimeSnapshot);
  const verified = useStore(runtimeVerified);
  const reading = useStore((s) => s.runtimeReading);
  const error = useStore((s) => s.runtimeReadError);
  const connected = useStore((s) => s.conn === 'connected');
  const running = useStore((s) => !!s.status?.engine?.running);
  const dirty = useStore((s) => s.saveState !== 'saved');
  const label = snapshot ? `${snapshot.project.name} · r${snapshot.rev}` : '尚未读回配置';
  const state = !connected ? '连接断开 · 仅显示上次回读缓存' : reading ? '正在从引擎读取…' : error ? `回读未核对：${error}` : !verified ? '配置已变化 · 待回读核对' : !running ? '引擎配置已回读核对 · 引擎未运行' : '引擎配置已回读核对';
  return <section className={`configuration-view ${runtime ? 'runtime' : 'draft'}`} aria-label="配置来源">
    <div className="configuration-switch">
      <button aria-pressed={runtime} onClick={() => void viewRuntime()}>查看正在运行</button>
      <button aria-pressed={!runtime} onClick={beginDraft}>编辑草稿</button>
    </div>
    <div className="configuration-source">
      <strong>{runtime ? '引擎配置 · 只读' : '本机草稿 · 编辑中'}</strong>
      <span className="runtime-name">{runtime ? label : `当前引擎配置：${label}`}</span>
      {!runtime && <span className="warnc">{dirty ? '草稿尚未应用' : '修改后须检查并应用'}；时间轴与日历预览为草稿内容</span>}
      <span className={verified && running ? 'runtime-confirmed' : 'warnc'} data-runtime-state>{state}</span>
      {snapshot && <small title={`配置文件：${snapshot.file}\n引擎实例：${snapshot.instanceId ?? '未知'}`}>读取于 {new Date(snapshot.readAt).toLocaleString('zh-CN', { hour12: false })} · 实例 {snapshot.instanceId?.slice(0, 8) ?? '未知'}</small>}
    </div>
    <button disabled={!connected || reading} onClick={() => void refreshRuntimeConfig()}>刷新运行配置</button>
  </section>;
}
