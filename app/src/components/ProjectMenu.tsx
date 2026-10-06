import { useEffect, useRef, useState } from 'react';
import { appBridge } from '../transport.ts';
import { openBackups, openSettings } from '../store.ts';
import type { AppState } from '../transport.ts';

import { configName } from '../lib/configName.ts';

/**
 * 顶栏的"配置"菜单：新建/打开/最近配置，以及开机自启、后台常驻等设置。
 * 这些依赖系统对话框，只在 Electron 里可用；浏览器调试时只显示当前项目文件名。
 */
export function ProjectMenu({ file }: { file: string | null }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<AppState | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appBridge) return;
    const load = () => void appBridge!.appState().then(setSt).catch(() => {});
    load();
    return appBridge.onAppState(load);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!appBridge) return <span className="projbtn static" title={file ?? ''}>配置：{configName(file)}</span>;
  const act = (name: string, arg?: unknown) => {
    setOpen(false);
    void appBridge!.appAction(name, arg);
  };

  return (
    <div className="projmenu" ref={box}>
      <button className="projbtn" onClick={() => setOpen(!open)} title={`当前配置文件：${file ?? ''}`}>
        ⚙ 配置 ▾
      </button>
      {open && st && (
        <div className="menu">
          <div className="mh">当前配置</div>
          <div className="mi off cur" title={file ?? ''}>{configName(file)}</div>
          <div className="ms" />
          <div className="mi" onClick={() => act('newProject')}>新建配置…</div>
          <div className="mi" onClick={() => act('openProject')}>打开配置…</div>
          <div className="mh">最近配置</div>
          {st.recent.filter((f) => f !== st.currentFile).length === 0 && <div className="mi off">（无）</div>}
          {st.recent.filter((f) => f !== st.currentFile).map((f) => (
            <div key={f} className="mi" title={f} onClick={() => act('openRecent', f)}>{configName(f)}</div>
          ))}
          <div className="ms" />
          <div className="mi" onClick={() => act('reveal')}>在文件夹中显示配置文件</div>
          <div className="mi" onClick={() => { setOpen(false); openBackups(); }}>从备份恢复…</div>
          <div className="ms" />
          <div className="mi" onClick={() => { setOpen(false); openSettings(); }}>设置…（网卡、开机自启）</div>
          <div className="ms" />
          <div className="mi" onClick={() => act('quit')}>退出界面（引擎继续运行）</div>
          <div className="mi danger" onClick={() => act('quitAndStopEngine')}>退出并停止引擎…</div>
        </div>
      )}
    </div>
  );
}
