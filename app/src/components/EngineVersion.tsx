import { useState } from 'react';
import { appBridge } from '../transport.ts';
import { toast, useStore } from '../store.ts';

export function RestartEngineButton() {
  const [busy, setBusy] = useState(false);
  const saveState = useStore((s) => s.saveState);
  const bridge = appBridge;
  if (!bridge) return null;
  return <button disabled={busy || saveState !== 'saved'} onClick={async () => {
    setBusy(true);
    try { await bridge.appAction('restartEngine'); }
    catch (e) { toast(`重启失败：${(e as Error).message}`); }
    finally { setBusy(false); }
  }}>{busy ? '正在重启…' : '重启引擎…'}</button>;
}

export function EngineVersionBanner() {
  const update = useStore((s) => s.engineUpdate);
  if (!update?.needsRestart) return null;
  return <div className={`banner ${update.compatible ? 'warn' : 'bad'} engine-version-banner`}>
    {update.compatible
      ? <span>正在运行的引擎（{update.runningVersion ?? '旧版本'}）不是最新构建，新版修复尚未生效。可以继续正常使用，建议在日程空档重启引擎。</span>
      : <span>引擎（{update.runningVersion ?? '未知旧版本'}）与界面通信协议不兼容：现在只能查看和急停，保存、发送等操作被暂停。请确认重启引擎。</span>}
    <RestartEngineButton />
  </div>;
}
