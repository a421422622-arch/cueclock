import { contextBridge, ipcRenderer } from 'electron';

// 只暴露最小接口给界面：请求引擎、订阅引擎事件、少量应用级操作。界面拿不到 Node 或令牌。
contextBridge.exposeInMainWorld('cueclock', {
  rpc: (method: string, params?: unknown) => ipcRenderer.invoke('rpc', method, params),
  appInfo: () => ipcRenderer.invoke('app:info'),
  appState: () => ipcRenderer.invoke('app:state'),
  appAction: (name: string, arg?: unknown) => ipcRenderer.invoke('app:action', name, arg),
  onEvent: (cb: (msg: { event: string; data: unknown }) => void) => {
    const h = (_e: unknown, msg: { event: string; data: unknown }) => cb(msg);
    ipcRenderer.on('daemon:event', h);
    return () => ipcRenderer.removeListener('daemon:event', h);
  },
  onConnection: (cb: (connected: boolean) => void) => {
    const h = (_e: unknown, v: boolean) => cb(v);
    ipcRenderer.on('daemon:conn', h);
    return () => ipcRenderer.removeListener('daemon:conn', h);
  },
  onNeedUnlock: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('app:need-unlock', h);
    return () => ipcRenderer.removeListener('app:need-unlock', h);
  },
  onResetLayout: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('app:reset-layout', h);
    return () => ipcRenderer.removeListener('app:reset-layout', h);
  },
  onAppState: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('app:state-changed', h);
    return () => ipcRenderer.removeListener('app:state-changed', h);
  },
});
