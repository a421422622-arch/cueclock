import { useSyncExternalStore } from 'react';
import type { Project } from '@engine/types.ts';
import type { EngineStatus, InFlightRun, LogEntry } from '@engine/engine.ts';
import type { Issue } from '@engine/validate.ts';
import { appBridge, transport, RpcFailure } from './transport.ts';
import type { EngineUpdate } from '../../engine/src/version.ts';
import { EditHistory } from './lib/history.ts';
import { readRuntimeConfig, snapshotCurrent, appliedSnapshotMatches, sameConfiguration } from './lib/runtimeConfig.ts';
import type { RuntimeConfigSnapshot } from './lib/runtimeConfig.ts';
import { normalizeEngineStatus } from './lib/status.ts';
import { diffToday } from './lib/todayDiff.ts';
import { pauseSummary } from './lib/pauseSummary.ts';
import type { PauseSummary } from './lib/pauseSummary.ts';
import type { TodayDiff } from './lib/todayDiff.ts';
import type { DayView } from '@engine/simulate.ts';
import { localMidnight } from '@engine/calendar.ts';

export interface DaemonStatus {
  protocol: number;
  daemon: { instanceId?: string; pid: number; projectFile: string; rev: number; startError: string | null; notice: string | null;
    /** 引擎里挂着、等正在执行的动作链结束后才应用的配置（0.6.0 起） */
    pendingApply?: { since: number; deadline: number; baseRev: number } | null };
  engine: EngineStatus | null;
  lock?: { enabled: boolean };
  network?: { settings: { localAddresses?: string[]; localPort?: number; listenAll?: boolean }; source: string; missing: string[]; available: boolean };
}

export type Selection =
  | { kind: 'cue'; timelineId: string; cueId: string; actionId?: string }
  | { kind: 'timeline'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'command'; id: string }
  | { kind: 'scene'; id: string }
  | { kind: 'pad'; id: string }
  | { kind: 'padTile'; padId: string; tileId: string }
  | null;

export type View = 'overview' | 'timeline' | 'calendar' | 'pad';
export type ConfigurationPage = 'files' | 'software';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface AppState {
  conn: 'connecting' | 'connected' | 'disconnected';
  loaded: boolean;
  status: DaemonStatus | null;
  /** 本地草稿，界面上的编辑都改它，本机自动保存，确认应用才交给引擎 */
  project: Project | null;
  runningProject: Project | null;
  configurationView: 'runtime' | 'draft';
  runtimeSnapshot: RuntimeConfigSnapshot | null;
  runtimeReading: boolean;
  runtimeReadError: string | null;
  rev: number;
  saveState: SaveState;
  issues: Issue[];
  applyPreview: { project: Project; instanceId: string; rev: number; version: number; changes: string[]; issues: Issue[]; inFlight: InFlightRun[];
    /** 今天剩余日程的变化；算不出来（断线 / 引擎未运行）为 null */
    today: TodayDiff | null } | null;
  /** 已交给引擎、等动作链结束后自动应用的草稿版本；seen = 已在引擎状态里看到它在等待 */
  deferredApply: { version: number; project: Project; deadline: number; seen: boolean } | null;
  /** 刚恢复自动日程：暂停期间跳过了什么（恢复不补发） */
  resumeSummary: PauseSummary | null;
  /** 打开着「检测记录」窗口的设备 id */
  pingMonitorId: string | null;
  logs: LogEntry[];
  sel: Selection;
  modeId: string | null;
  followActive: boolean;
  canUndo: boolean;
  canRedo: boolean;
  view: View;
  settingsOpen: boolean;
  configurationPage: ConfigurationPage;
  /** 操作面板：当前面板 id；是否处于编辑模式 */
  padId: string | null;
  /** 编辑锁：enabled=引擎里设了密码；unlocked=本连接已解锁。锁定时只读（查看、急停仍可用） */
  lock: { enabled: boolean; unlocked: boolean };
  unlockOpen: boolean;
  backupOpen: boolean;
  /** 批量设置在线检测对话框；init 是起点设置（从某台设备带过来），null/undefined 表示用默认 */
  batchHealthOpen: boolean;
  batchHealthInit: import('../../engine/src/types.ts').DeviceHealthConfig | null;
  /** 日志区当前页签；顶栏告警徽标要能直接切过去 */
  logTab: 'log' | 'alerts' | 'issues';
  /** 磁盘上的历史告警（最近 7 天）；实时告警在 logs 里 */
  alertHistory: LogEntry[];
  /** 上次查看告警的时间戳，之后的 warn/error 才算新告警 */
  alertsSeenAt: number;
  logCollapsed: boolean;
  engineUpdate: EngineUpdate | null;
  /** 上次没能保存（有错误）的草稿，等用户决定恢复还是丢弃 */
  draftOffer: { at: number; project: Project } | null;
  /** 引擎时间 - 本机时间，用来显示引擎的时钟 */
  clockOffset: number;
  toast: string | null;
}

const SEEN_KEY = 'cueclock-alerts-seen';
function readSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

let state: AppState = {
  conn: 'connecting',
  loaded: false,
  status: null,
  project: null,
  runningProject: null,
  configurationView: 'runtime',
  runtimeSnapshot: null,
  runtimeReading: false,
  runtimeReadError: null,
  rev: 0,
  saveState: 'saved',
  issues: [],
  applyPreview: null,
  deferredApply: null,
  resumeSummary: null,
  pingMonitorId: null,
  logs: [],
  sel: null,
  modeId: null,
  followActive: true,
  canUndo: false,
  canRedo: false,
  view: 'overview',
  settingsOpen: false,
  configurationPage: 'files',
  padId: null,
  lock: { enabled: false, unlocked: true },
  unlockOpen: false,
  backupOpen: false,
  batchHealthOpen: false,
  batchHealthInit: null,
  logTab: 'log',
  alertHistory: [],
  alertsSeenAt: readSeenAt(),
  logCollapsed: false,
  engineUpdate: null,
  draftOffer: null,
  clockOffset: 0,
  toast: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export const getState = () => state;
type EditSnapshot = { project: Project; sel: Selection; modeId: string | null };
const history = new EditHistory<EditSnapshot>(50);
const snapshot = (): EditSnapshot => ({ project: state.project!, sel: state.sel, modeId: state.modeId });
export const displayedProject = (s: AppState): Project | null => s.configurationView === 'draft' ? s.project : s.runtimeSnapshot?.project ?? s.runningProject;
export const viewingRuntime = (s: AppState): boolean => s.configurationView === 'runtime';
export const runtimeVerified = (s: AppState): boolean => !s.runtimeReading && !s.runtimeReadError && snapshotCurrent(s.runtimeSnapshot, s.status, s.conn === 'connected');
const historyState = () => ({ canUndo: history.canUndo, canRedo: history.canRedo });
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

// ───────────── 草稿保护 ─────────────
// 有错误的项目引擎不会接受（防止现场日程被改坏），所以编辑到一半、还不合法的内容不会保存到引擎。
// 为了不因为关窗口/崩溃丢掉这些修改，另外存一份草稿在浏览器本地存储里，下次打开时询问是否恢复。

const draftKey = () => `cueclock-draft:${state.status?.daemon.projectFile ?? ''}`;
function writeDraft(): void {
  try {
    if (state.project) localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), project: state.project }));
  } catch {
    set({ saveState: 'error' });
    toast('本机草稿保存失败，请保持窗口打开，检查并应用后再关闭');
  }
}
function clearDraft(): void {
  try {
    localStorage.removeItem(draftKey());
  } catch {
    /* 忽略 */
  }
}
function readDraft(): { at: number; project: Project } | null {
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? (JSON.parse(raw) as { at: number; project: Project }) : null;
  } catch {
    return null;
  }
}

/** 恢复草稿：作为本地修改载入，等待检查并应用（仍有错误会在「问题」里显示）。 */
export function restoreDraft(): void {
  if (state.engineUpdate && !state.engineUpdate.compatible) { toast('界面与引擎协议或功能版本不兼容，请先确认重启引擎，再恢复本地草稿'); return; }
  if (isLocked()) { denyLocked(); return; }
  const d = state.draftOffer;
  if (!d) return;
  if (state.project) history.record(snapshot());
  draftBase = state.runtimeSnapshot?.project ?? state.runningProject; // 起点未知，按「恢复时的引擎配置」计
  editVersion++;
  set({ project: d.project, configurationView: 'draft', sel: null, draftOffer: null, saveState: 'dirty', ...historyState() });
  scheduleSave(0);
}

export function discardDraft(): void {
  clearDraft();
  set({ draftOffer: null });
}

// ───────────── 加载与同步 ─────────────

let editVersion = 0; // 每次本地编辑 +1
let savedVersion = 0; // 已成功保存的版本
let projectSession = 0; // 防止项目切换后旧保存响应改写新项目状态
/**
 * 草稿基于哪一份引擎配置开始编辑。引擎重启后修订号会从 0 重新计数、实例也变了，
 * 但内容可能完全没变——这时不算冲突，把草稿接到新修订号上即可（否则只能丢弃草稿）。
 */
let draftBase: Project | null = null;

export const isLocked = (): boolean => state.lock.enabled && !state.lock.unlocked;

/** 被锁定时的统一提示：弹出解锁框。 */
function denyLocked(): void {
  toast('编辑已锁定：请先输入密码解锁（查看和急停不受影响）');
  set({ unlockOpen: true });
}

function applyStatus(st: DaemonStatus): void {
  // 引擎状态里带着「是否设了密码」；密码被移除时本连接自然变成已解锁
  if (st.lock && st.lock.enabled !== state.lock.enabled) set({ lock: { enabled: st.lock.enabled, unlocked: st.lock.enabled ? state.lock.unlocked : true } });
  const changedInstance = !!state.status?.daemon.instanceId && !!st.daemon.instanceId && state.status.daemon.instanceId !== st.daemon.instanceId;
  if (changedInstance && state.deferredApply) { set({ deferredApply: null }); toast('引擎已重启，延后应用随之取消；草稿仍保留'); }
  const now = st.engine?.now;
  set({ status: { ...st, engine: normalizeEngineStatus(st.engine) }, ...(now ? { clockOffset: now - Date.now() } : {}) });
  const deferred = state.deferredApply;
  if (deferred && st.daemon.pendingApply && !deferred.seen) set({ deferredApply: { ...deferred, seen: true } });
  else if (deferred?.seen && !st.daemon.pendingApply && st.daemon.rev === state.rev && !changedInstance) {
    // 引擎放弃了等待（超时 / 手动取消 / 被替换），配置没变：草稿还在本机，提示用户
    set({ deferredApply: null });
    toast('延后应用已放弃，新配置没有应用（原因见日志）；草稿仍保留');
  }
  if (state.loaded && (st.daemon.rev !== state.runtimeSnapshot?.rev || changedInstance || st.daemon.projectFile !== state.runtimeSnapshot?.file) && !inflight && !state.runtimeReading) {
    void refreshRuntimeConfig(); // 有草稿时由回读结果判断是否真的冲突
  }
}

let runtimeReadId = 0;
export async function refreshRuntimeConfig(): Promise<RuntimeConfigSnapshot | null> {
  const id = ++runtimeReadId, session = projectSession;
  set({ runtimeReading: true, runtimeReadError: null });
  try {
    const r = await readRuntimeConfig<DaemonStatus>(transport.request);
    if (session !== projectSession || id !== runtimeReadId) return null;
    const deferred = state.deferredApply;
    const deferredDone = !!deferred && sameConfiguration(r.snapshot.project, deferred.project);
    if (deferredDone) { savedVersion = deferred.version; draftBase = deferred.project; } // 引擎自动应用了我们挂起的那一份
    const clean = editVersion === savedVersion;
    if (clean) history.clear();
    // 有草稿：引擎内容与草稿的起点一致（只是重启 / 修订号变了）→ 接到新修订号继续；内容真变了 → 冲突
    const rebase = !clean && sameConfiguration(r.snapshot.project, draftBase);
    set({ runtimeSnapshot: r.snapshot, runningProject: r.snapshot.project, runtimeReading: false,
      ...(clean ? { project: r.snapshot.project, rev: r.snapshot.rev, ...historyState() } : {}),
      ...(rebase ? { rev: r.snapshot.rev, ...(state.saveState === 'conflict' ? { saveState: 'dirty' as const } : {}) } : {}),
      ...(!clean && !rebase ? { saveState: 'conflict' as const } : {}),
      ...(deferredDone ? { deferredApply: null, saveState: clean ? 'saved' as const : 'dirty' as const, ...(clean ? { configurationView: 'runtime' as const } : {}) } : {}) });
    if (deferredDone) { if (clean) clearDraft(); else writeDraft(); toast(`动作链已结束，引擎已自动应用新配置 r${r.snapshot.rev} 并回读核对`); }
    applyStatus(r.status);
    return r.snapshot;
  } catch (e) {
    if (session === projectSession && id === runtimeReadId) set({ runtimeReading: false, runtimeReadError: (e as Error).message });
    return null;
  }
}

export function beginDraft(): boolean {
  if (!editable()) { toast('请先解锁或更新引擎后编辑'); return false; }
  set({ configurationView: 'draft' }); // 操作面板：草稿 = 编辑布局，运行 = 操作
  return true;
}
export async function viewRuntime(): Promise<void> {
  set({ configurationView: 'runtime' }); // 保留选中：检查器对不存在的对象自动显示空白
  await refreshRuntimeConfig();
}

async function loadAll(): Promise<void> {
  const session = ++projectSession;
  ++runtimeReadId;
  clearTimeout(timer); // 切换项目后，旧项目遗留的待保存定时器不能再触发
  const [runtime, logs] = await Promise.all([
    readRuntimeConfig<DaemonStatus>(transport.request),
    transport.request<LogEntry[]>('getLogs', { limit: 500 }),
  ]);
  const { project, rev } = runtime.snapshot, st = runtime.status;
  if (session !== projectSession) return;
  const changedFile = state.status?.daemon.projectFile !== st.daemon.projectFile;
  if (changedFile || JSON.stringify(state.project) !== JSON.stringify(project)) history.clear();
  editVersion = savedVersion = 0;
  draftBase = null;
  set({ runtimeSnapshot: runtime.snapshot, runtimeReading: false, runtimeReadError: null, project, runningProject: project, applyPreview: null, rev, loaded: true, saveState: 'saved', issues: [], logs, draftOffer: null, ...historyState(),
    ...(changedFile ? { configurationView: 'runtime', sel: null, modeId: null, followActive: true } : {}) });
  applyStatus(st);
  void loadAlertHistory();
  void refreshLock();
  // 有没有上次遗留的、没能保存的草稿？内容和引擎里的一样就没必要提示
  const draft = readDraft();
  if (draft && JSON.stringify(draft.project) !== JSON.stringify(project)) set({ draftOffer: draft });
  else if (draft) clearDraft();
}

/** 断线重连后：本地没改动就整体重载；有改动就保留草稿，由下次保存时检测冲突。 */
async function resync(): Promise<void> {
  if (!state.loaded || editVersion === savedVersion) {
    await loadAll();
    return;
  }
  const st = await transport.request<DaemonStatus>('status');
  applyStatus(st);
  if (st.daemon.rev !== state.rev || st.daemon.instanceId !== state.runtimeSnapshot?.instanceId) void refreshRuntimeConfig(); // 回读后判断是接续还是冲突
  else scheduleSave(0);
}

export async function init(): Promise<void> {
  const bridge = appBridge;
  if (bridge) {
    const updateVersion = () => void bridge.appState().then((s) => set({ engineUpdate: s.engineUpdate ?? null })).catch(() => {});
    bridge.onAppState(updateVersion);
    updateVersion();
  }
  transport.onConnection((c) => {
    set({ conn: c ? 'connected' : 'disconnected' });
    if (c) {
      void resync().catch(() => {});
      void refreshLock(); // 重连后是新连接，解锁状态要重新问
    }
  });
  transport.onEvent((event, data) => {
    if (event === 'log') {
      const logs = state.logs.length >= 2000 ? state.logs.slice(-1500) : state.logs;
      set({ logs: [...logs, data as LogEntry] });
    } else if (event === 'status') {
      applyStatus(data as DaemonStatus);
    } else if (event === 'project-changed') {
      protectDraft();
      // 引擎切换了项目（本机或别的客户端触发）：丢弃本地草稿，整体重载
      select(null);
      void loadAll().catch(() => {});
    }
  });
  try {
    await loadAll();
    set({ conn: 'connected' });
  } catch {
    set({ conn: 'disconnected' });
  }
  // 引擎只在变更时推送状态；"接下来的事件"随时间变化，所以定时拉取
  setInterval(() => {
    if (state.conn !== 'connected') return;
    transport.request<DaemonStatus>('status').then(applyStatus).catch(() => {});
  }, 5000);
}

// ───────────── 编辑草稿与确认应用 ─────────────

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;

/** 草稿在本机自动保存并检查；不会自动交给引擎。 */
function scheduleSave(delay = 700): void {
  writeDraft();
  clearTimeout(timer);
  timer = setTimeout(() => void checkDraft(), delay);
}

async function checkDraft(): Promise<void> {
  if (!state.project) return;
  const version = editVersion, session = projectSession;
  try {
    const issues = await transport.request<Issue[]>('validateProject', { project: state.project });
    if (version === editVersion && session === projectSession) set({ issues });
  } catch { /* 断线时草稿保留，运行配置不变。应用时会重新检查。 */ }
}

export const closeApplyPreview = () => { if (!inflight) set({ applyPreview: null }); };
export async function cancelDeferredApply(): Promise<void> {
  try { await transport.request('cancelPendingApply'); } catch (e) { toast(`取消失败：${(e as Error).message}`); return; }
  set({ deferredApply: null });
  toast('已取消延后应用；草稿仍保留，可以重新检查并应用');
}

/** 用引擎的模拟分别算运行配置和草稿今天的计划，比较此刻之后的部分。 */
async function todayChanges(project: Project): Promise<TodayDiff | null> {
  const date = state.status?.engine?.date;
  if (!date) return null;
  try {
    const [[before], [after]] = await Promise.all([
      transport.request<DayView[]>('simulate', { from: date, days: 1 }),
      transport.request<DayView[]>('simulate', { project, from: date, days: 1 }),
    ]);
    return before && after ? diffToday(before, after, engineNow() - localMidnight(date)) : null;
  } catch { return null; }
}

export async function prepareApply(): Promise<void> {
  if (isLocked()) { denyLocked(); return; }
  if (!state.project || state.conn !== 'connected') { toast('请先连接引擎'); return; }
  const project = structuredClone(state.project), version = editVersion, session = projectSession;
  try {
    const r = await transport.request<{ instanceId: string; rev: number; changes: string[]; issues: Issue[]; inFlight?: InFlightRun[] }>('previewProject', { project, baseRev: state.rev });
    const today = await todayChanges(project);
    if (session === projectSession) set({ applyPreview: { ...r, inFlight: r.inFlight ?? [], today, project, version }, issues: r.issues });
  } catch (e) {
    if (e instanceof RpcFailure && e.code === 'conflict') set({ saveState: 'conflict' });
    toast(`预览失败：${(e as Error).message}`);
  }
}

/** whenIdle：有动作链正在执行时交给引擎挂起，等它们结束再应用（不取消任何动作）。 */
export async function applyConfiguration(whenIdle = false): Promise<void> {
  if (inflight || !state.applyPreview) return;
  if (isLocked()) { denyLocked(); return; }
  const preview = state.applyPreview, session = projectSession;
  inflight = true; set({ saveState: 'saving' });
  try {
    const r = await transport.request<{ rev: number; warnings: Issue[]; deferred?: boolean; deadline?: number; waitingFor?: number }>('applyProject', { project: preview.project, baseRev: preview.rev, instanceId: preview.instanceId, whenIdle });
    if (session !== projectSession) return;
    if (r.deferred) {
      set({ saveState: 'dirty', applyPreview: null, deferredApply: { version: preview.version, project: preview.project, deadline: r.deadline ?? 0, seen: !!state.status?.daemon.pendingApply } });
      toast(`已交给引擎：${r.waitingFor ?? ''} 个动作链结束后自动应用`);
      return;
    }
    savedVersion = preview.version;
    draftBase = preview.project; // 应用期间又改了的部分，起点就是刚应用的这一份
    const clean = editVersion === savedVersion;
    if (clean) clearDraft(); else writeDraft();
    set({ rev: r.rev, issues: clean ? r.warnings : state.issues, saveState: clean ? 'saved' : 'dirty', applyPreview: null, configurationView: 'runtime' });
    const actual = await refreshRuntimeConfig();
    if (session !== projectSession) return;
    if (!actual) toast('配置已应用，但引擎回读未核对；请刷新运行配置');
    else if (appliedSnapshotMatches(actual, preview.project, r.rev, preview.instanceId)) toast(`引擎配置 r${actual.rev} 已回读核对，旧版本已备份`);
    else toast(`配置已应用，但运行配置随后变化，当前从引擎读回版本 r${actual.rev}`);
  } catch (e) {
    if (session !== projectSession) return;
    if (e instanceof RpcFailure && e.code === 'conflict') set({ saveState: 'conflict', applyPreview: null });
    else if (e instanceof RpcFailure && e.code === 'invalid-project') set({ issues: e.details as Issue[], saveState: 'dirty' });
    else set({ saveState: 'dirty' });
    writeDraft(); toast(`应用失败：${(e as Error).message}`);
  } finally { inflight = false; }
}

export function edit(fn: (draft: Project) => void): void {
  if (!state.project) return;
  if (state.configurationView !== 'draft') { toast('当前查看引擎配置，只读；请切到编辑草稿'); return; }
  if (state.engineUpdate && !state.engineUpdate.compatible) { toast('界面与引擎协议或功能版本不兼容，请先确认重启引擎后再编辑'); return; }
  if (isLocked()) { denyLocked(); return; }
  const next = structuredClone(state.project);
  fn(next);
  if (JSON.stringify(next) === JSON.stringify(state.project)) return;
  history.record(snapshot());
  if (editVersion === savedVersion) draftBase = state.runtimeSnapshot?.project ?? state.runningProject;
  editVersion++;
  set({ project: next, saveState: state.saveState === 'conflict' ? 'conflict' : 'dirty', ...historyState() });
  scheduleSave(); // 冲突时也要写本机草稿，否则冲突期间的修改关窗就丢了
}

function restoreEdit(next: EditSnapshot | null): void {
  if (!next) return;
  if (editVersion === savedVersion) draftBase = state.runtimeSnapshot?.project ?? state.runningProject;
  editVersion++;
  set({ ...next, followActive: false, saveState: state.saveState === 'conflict' ? 'conflict' : 'dirty', ...historyState() });
  scheduleSave();
}
/** 渲染异常时保存尚未交给引擎的草稿，重新加载不会丢失本地编辑。 */
export function protectDraft(): void { if (editVersion !== savedVersion) writeDraft(); }
export const undo = () => state.configurationView === 'draft' && state.project && editable() && restoreEdit(history.undo(snapshot()));
export const redo = () => state.configurationView === 'draft' && state.project && editable() && restoreEdit(history.redo(snapshot()));
/** 协议或功能版本不兼容时不允许编辑（保存会被拦截）；仅构建不同则照常。 */
function editable(): boolean {
  if (isLocked()) { denyLocked(); return false; }
  return !state.engineUpdate || state.engineUpdate.compatible;
}

/** 编辑控件内保留浏览器的文本撤销；其余位置使用项目历史。 */
export function handleEditShortcut(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y')) return;
  if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable=true]')) return;
  e.preventDefault();
  if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
  else undo();
}

/**
 * 真冲突时的另一条路：以本机草稿为准。把草稿接到引擎当前修订号上，然后打开「检查并应用」——
 * 变更清单是相对引擎**当前**配置计算的，所以别处做的、会被覆盖掉的修改都会列出来，确认后才生效。
 */
export async function keepDraftOverEngine(): Promise<void> {
  const latest = await refreshRuntimeConfig();
  if (!latest) { toast('无法读取引擎当前配置，稍后再试'); return; }
  draftBase = latest.project;
  set({ rev: latest.rev, saveState: 'dirty', configurationView: 'draft' });
  await prepareApply();
}

export async function reloadFromEngine(): Promise<void> {
  clearDraft();
  await loadAll();
}

export function select(sel: Selection): void {
  const modeId = sel?.kind === 'timeline' ? sel.id : sel?.kind === 'cue' ? sel.timelineId : null;
  set({ sel, ...(modeId ? { modeId, followActive: false } : {}) });
}

export function setMode(id: string): void {
  set({ modeId: id, followActive: false, sel: { kind: 'timeline', id } });
}
export function followMode(): void { set({ followActive: true, sel: null }); }
export function syncActiveMode(id: string): void {
  if (state.followActive && state.modeId !== id) set({ modeId: id, sel: null });
}

export function setView(view: View): void {
  set({ view });
}

/** 恢复自动日程，并告诉操作员暂停期间跳过了哪些（不会补发）。 */
export async function resumeSchedule(): Promise<void> {
  await transport.request('resume');
  const summary = pauseSummary(state.logs, engineNow());
  if (summary.skippedTotal || summary.ignoredPackets) set({ resumeSummary: summary });
  else toast('已恢复自动日程；暂停期间没有跳过任何事件');
}
export const openPingMonitor = (id: string) => set({ pingMonitorId: id });
export const closePingMonitor = () => set({ pingMonitorId: null });
export const closeResumeSummary = () => set({ resumeSummary: null });

export function showLogTab(tab: AppState['logTab']): void {
  set({ logTab: tab, ...(state.logCollapsed ? { logCollapsed: false } : {}) });
}
export function markAlertsSeen(): void {
  const t = Date.now();
  try {
    localStorage.setItem(SEEN_KEY, String(t));
  } catch {
    /* 存储不可用就只在本次有效 */
  }
  set({ alertsSeenAt: t });
}
export async function refreshLock(): Promise<void> {
  try {
    set({ lock: await transport.request<{ enabled: boolean; unlocked: boolean }>('lockStatus') });
  } catch {
    set({ lock: { enabled: false, unlocked: true } }); // 旧版引擎没有编辑锁
  }
}

/** 返回错误信息；成功返回 null。 */
async function lockCall(method: string, params?: unknown): Promise<string | null> {
  try {
    set({ lock: await transport.request<{ enabled: boolean; unlocked: boolean }>(method, params) });
    return null;
  } catch (e) {
    return e instanceof RpcFailure ? e.message : (e as Error).message;
  }
}

export async function unlock(password: string): Promise<string | null> {
  const err = await lockCall('unlock', { password });
  if (!err) {
    set({ unlockOpen: false });
    if (state.saveState === 'dirty') scheduleSave(0); // 锁定期间没能保存的修改，解锁后继续保存
  }
  return err;
}
export const lockNow = () => lockCall('lock');
export const setLockPassword = (password: string, current?: string) => lockCall('setPassword', { password, current });
export const removeLockPassword = (password: string) => lockCall('removePassword', { password });
export const openUnlock = () => set({ unlockOpen: true });
export const closeUnlock = () => set({ unlockOpen: false });
export const setPadId = (id: string | null) => set({ padId: id });
/** 从问题列表等处直接跳到某个面板按钮：切到面板视图、进入编辑草稿并选中它 */
export function showPadTile(padId: string, tileId?: string): void {
  if (!beginDraft()) return;
  set({ view: 'pad', padId, sel: tileId ? { kind: 'padTile', padId, tileId } : { kind: 'pad', id: padId } });
}
export const openBatchHealth = (init: import('../../engine/src/types.ts').DeviceHealthConfig | null = null) => set({ batchHealthOpen: true, batchHealthInit: init });
export const closeBatchHealth = () => set({ batchHealthOpen: false });
export const openBackups = () => set({ backupOpen: true });
export const closeBackups = () => set({ backupOpen: false });

export async function loadAlertHistory(): Promise<void> {
  try {
    set({ alertHistory: await transport.request<LogEntry[]>('getAlerts', { days: 7, limit: 500 }) });
  } catch {
    set({ alertHistory: [] }); // 旧版引擎没有这个接口：只显示本次运行里的实时告警
  }
}

export const openConfiguration = (page: ConfigurationPage = 'files') => set({ settingsOpen: true, configurationPage: page });
export const setConfigurationPage = (page: ConfigurationPage) => set({ configurationPage: page });
/** 网络/引擎问题的快捷入口直接定位到软件设置页。 */
export const openSettings = () => openConfiguration('software');
export const closeSettings = () => set({ settingsOpen: false });
export const toggleLog = () => set({ logCollapsed: !state.logCollapsed });

export function toast(msg: string | null): void {
  set({ toast: msg });
  if (msg) setTimeout(() => state.toast === msg && set({ toast: null }), 4000);
}

// ───────────── 对引擎的操作 ─────────────

export const rpc = <T = unknown>(method: string, params?: unknown) => transport.request<T>(method, params);
export const engineNow = () => Date.now() + state.clockOffset;
