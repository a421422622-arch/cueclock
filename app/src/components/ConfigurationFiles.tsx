import { useEffect, useState } from 'react';
import { appBridge } from '../transport.ts';
import type { AppState } from '../transport.ts';
import { openBackups, toast, useStore } from '../store.ts';
import { configName } from '../lib/configName.ts';

/** 文件页沿用原生对话框、切换确认、编辑锁和备份恢复。 */
export function ConfigurationFiles() {
  const project = useStore((s) => s.project)!;
  const file = useStore((s) => s.status?.daemon.projectFile ?? null);
  const [info, setInfo] = useState<AppState | null>(null);
  const bridge = appBridge;
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    const load = () => void bridge.appState().then((value) => { if (mounted) setInfo(value); }).catch(() => {});
    load();
    const off = bridge.onAppState(load);
    return () => { mounted = false; off(); };
  }, [bridge]);
  const act = async (name: string, arg?: unknown) => {
    try { await bridge?.appAction(name, arg); }
    catch (e) { toast(`操作失败：${(e as Error).message}`); }
  };
  const recent = (info?.recent ?? []).filter((path) => path !== file);
  return <>
    <div className="configuration-current">
      <span className="hint">当前配置</span>
      <strong>{project.name || configName(file)}</strong>
      <span className="configuration-path mono" title={file ?? ''}>{file ?? '尚未读取配置位置'}</span>
      <button disabled={!bridge || !file} onClick={() => void act('reveal')}>在文件夹中显示</button>
    </div>
    <div className="configuration-actions">
      <button className="primary" disabled={!bridge} onClick={() => void act('newProject')}>新建配置…</button>
      <button disabled={!bridge} onClick={() => void act('openProject')}>打开配置…</button>
    </div>
    {!bridge && <div className="hint">新建和打开配置请在桌面应用中操作。</div>}
    <div className="hint">打开其他配置前会确认切换；当前日程会改为使用新配置。</div>
    <div className="sech">最近配置</div>
    <div className="configuration-recents">
      {!info && bridge ? <div className="empty">读取中…</div> : recent.length === 0 ? <div className="empty">暂无其他最近配置。</div> :
        recent.map((path) => <button key={path} className="configuration-recent" title={path} onClick={() => void act('openRecent', path)}>
          <b>{configName(path)}</b><span className="hint mono">{path}</span><span className="configuration-open">打开 ›</span>
        </button>)}
    </div>
    <div className="sech">配置备份</div>
    <div className="hint">保存前自动备份旧版本，至少间隔 1 分钟，保留最近 30 份。</div>
    <div className="row"><button onClick={openBackups}>从备份恢复…</button></div>
  </>;
}
