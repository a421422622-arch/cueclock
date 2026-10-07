import type { Project } from './types.ts';
import type { LogEntry } from './engine.ts';
import type { AuditEntry } from './audit.ts';
import { normalizeProject } from './store.ts';

/**
 * 备份包：一个 JSON 文件，包含还原配置所需的一切（项目 + 机器设置），并附带诊断信息（运行状态、最近日志 / 告警 / 操作记录）。
 * 新机器或重装后，用它一步还原；出问题时把它发给维护的人。
 * 不含：编辑锁密码（要在新机器上重新设置）、设备接管、面板亮灯状态（都是运行时状态）。
 */
export const BUNDLE_FORMAT = 'cueclock-bundle';
export const BUNDLE_VERSION = 1;

export interface BundleSettings { network?: unknown; preventSleep: boolean; healthPaused: boolean }
export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  createdAt: string;
  createdBy: { engineVersion: string; engineBuild: string; protocol: number; platform: string; arch: string };
  project: { name: string; file: string; rev: number; data: Project };
  settings: BundleSettings;
  runtime: { running: boolean; paused: boolean; date?: string; dayKind?: string; devices: { id: string; name: string; ip: string; state: string; lastCheckAt: number | null; fails: number }[] };
  logs: LogEntry[];
  alerts: LogEntry[];
  audit: AuditEntry[];
  backups: { name: string; t: number; size: number; projectName?: string }[];
  note: string;
}

export class BundleError extends Error {}

/** 读入并校验备份包：格式、版本、项目内容。通过后项目已规整（缺的数组补空）。 */
export function parseBundle(raw: unknown): { bundle: Bundle; project: Project } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BundleError('这不是备份包（内容不是对象）');
  const b = raw as Partial<Bundle>;
  if (b.format !== BUNDLE_FORMAT) throw new BundleError('这不是 CueClock 备份包（format 不对）。如果是单独的项目文件，请用「打开配置…」');
  if (typeof b.formatVersion !== 'number' || b.formatVersion < 1) throw new BundleError('备份包缺少版本号');
  if (b.formatVersion > BUNDLE_VERSION) throw new BundleError(`备份包来自更新的软件版本（格式 ${b.formatVersion}，本机只认识到 ${BUNDLE_VERSION}），请先升级软件`);
  if (!b.project || typeof b.project !== 'object' || typeof b.project.data !== 'object' || b.project.data === null) throw new BundleError('备份包里没有项目数据');
  let project: Project;
  try { project = normalizeProject(b.project.data); } catch (e) { throw new BundleError(`备份包里的项目数据损坏：${(e as Error).message}`); }
  const s = (b.settings ?? {}) as Partial<BundleSettings>;
  return { project, bundle: { ...(b as Bundle), settings: { network: s.network, preventSleep: s.preventSleep === true, healthPaused: s.healthPaused === true } } };
}

export function countProject(p: Project) {
  return { devices: p.devices.length, commands: (p.commands ?? []).length, scenes: (p.scenes ?? []).length, pads: (p.pads ?? []).length,
    tiles: (p.pads ?? []).reduce((n, x) => n + x.tiles.length, 0), timelines: p.timelines.length, cues: p.timelines.reduce((n, t) => n + t.cues.length, 0), triggers: p.triggers.length };
}
