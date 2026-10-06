// 界面与引擎之间的传输层。Electron 里走 preload 暴露的 IPC；
// 在浏览器里调试时走 Vite 开发桥（/__rpc + /__events）。两者对界面代码完全一样。

export interface RpcErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

export class RpcFailure extends Error {
  code: string;
  details?: unknown;
  constructor(e: RpcErrorInfo) {
    super(e.message);
    this.code = e.code;
    this.details = e.details;
  }
}

export interface Transport {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(cb: (event: string, data: unknown) => void): () => void;
  onConnection(cb: (connected: boolean) => void): () => void;
  /** 当前是否已连上引擎（用于首次加载） */
  readonly kind: 'electron' | 'web';
}

type Reply = { ok: true; result: unknown } | { ok: false; error: RpcErrorInfo };

interface Bridge {
  rpc(method: string, params?: unknown): Promise<Reply>;
  onEvent(cb: (msg: { event: string; data: unknown }) => void): () => void;
  onConnection(cb: (connected: boolean) => void): () => void;
}

function unwrap<T>(r: Reply): T {
  if (r.ok) return r.result as T;
  throw new RpcFailure(r.error);
}

function electronTransport(b: Bridge): Transport {
  return {
    kind: 'electron',
    request: async <T,>(method: string, params?: unknown) => unwrap<T>(await b.rpc(method, params)),
    onEvent: (cb) => b.onEvent((m) => cb(m.event, m.data)),
    onConnection: (cb) => b.onConnection(cb),
  };
}

function webTransport(): Transport {
  const connListeners = new Set<(c: boolean) => void>();
  const eventListeners = new Set<(e: string, d: unknown) => void>();
  const es = new EventSource('/__events');
  es.onmessage = (m) => {
    const { event, data } = JSON.parse(m.data) as { event: string; data: unknown };
    if (event === 'conn') connListeners.forEach((l) => l(Boolean(data)));
    else eventListeners.forEach((l) => l(event, data));
  };
  return {
    kind: 'web',
    request: async <T,>(method: string, params?: unknown) => {
      const res = await fetch('/__rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
      return unwrap<T>((await res.json()) as Reply);
    },
    onEvent: (cb) => {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    onConnection: (cb) => {
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
  };
}

export interface AppState {
  engineUpdate?: import('../../engine/src/version.ts').EngineUpdate | null;
  isMac: boolean;
  recent: string[];
  currentFile: string | null;
  keepInTray: boolean;
  launchAtLogin: boolean;
  launchAtLoginStale: boolean;
  canLaunchAtLogin: boolean;
  isPackaged: boolean;
  platform: string;
}

/** 只有 Electron 里才有：项目对话框、托盘、开机自启等应用级操作。浏览器调试时为 null。 */
export interface AppBridge {
  appState(): Promise<AppState>;
  appAction(name: string, arg?: unknown): Promise<void>;
  onAppState(cb: () => void): () => void;
  onNeedUnlock(cb: () => void): () => void;
}

declare global {
  interface Window {
    cueclock?: Bridge & AppBridge & { appInfo(): Promise<{ stateDir: string; projectFile: string; platform: string }> };
  }
}

export const appBridge: AppBridge | null = window.cueclock ?? null;

export const transport: Transport = window.cueclock ? electronTransport(window.cueclock) : webTransport();
