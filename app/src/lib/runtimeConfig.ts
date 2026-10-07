import type { Project } from '../../../engine/src/types.ts';

export interface RuntimeConfigSnapshot {
  project: Project;
  rev: number;
  instanceId?: string;
  file: string;
  readAt: number;
}
export interface RuntimeIdentity { daemon: { rev: number; instanceId?: string; projectFile: string } }
type Request = <T>(method: string, params?: unknown) => Promise<T>;

export function snapshotCurrent(snapshot: RuntimeConfigSnapshot | null, status: RuntimeIdentity | null, connected: boolean): boolean {
  return !!snapshot && !!status && connected && snapshot.rev === status.daemon.rev && snapshot.instanceId === status.daemon.instanceId && snapshot.file === status.daemon.projectFile;
}

/** 用一条RPC取配置及身份，再核对当前状态；不把混合版本标记成已确认。 */
export async function readRuntimeConfig<S extends RuntimeIdentity = RuntimeIdentity>(request: Request, now = Date.now): Promise<{ snapshot: RuntimeConfigSnapshot; status: S }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await request<Omit<RuntimeConfigSnapshot, 'readAt'>>('getProject');
    const status = await request<S>('status');
    const snapshot = { ...result, readAt: now() };
    if (snapshotCurrent(snapshot, status, true)) return { snapshot, status };
  }
  throw new Error('读取期间引擎配置持续变化，未能核对，请刷新');
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
}

export function appliedSnapshotMatches(snapshot: RuntimeConfigSnapshot, project: Project, rev: number, instanceId?: string): boolean {
  return snapshot.rev === rev && snapshot.instanceId === instanceId && canonical(snapshot.project) === canonical(project);
}
