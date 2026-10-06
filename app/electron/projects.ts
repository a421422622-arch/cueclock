import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'node:path';
import { configName } from '../src/lib/configName.ts';
import type { DaemonClient } from '../../engine/src/client.ts';
import { RpcError } from '../../engine/src/protocol.ts';
import type { Issue } from '../../engine/src/validate.ts';

export interface ProjectDeps {
  getClient: () => DaemonClient | null;
  getWindow: () => BrowserWindow | null;
  /** 当前项目文件（用于确认框文案） */
  currentFile: () => string | null;
  /** 自检用：跳过所有确认对话框 */
  noPrompt?: boolean;
}

const FILTERS = [{ name: 'CueClock 配置', extensions: ['json'] }];

function box(win: BrowserWindow | null, opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return win && win.isVisible() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

async function confirmSwitch(d: ProjectDeps, target: string): Promise<boolean> {
  if (d.noPrompt) return true;
  const r = await box(d.getWindow(), {
    type: 'question',
    buttons: ['切换配置', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `切换到配置「${configName(target)}」？`,
    detail: '当前配置的日程和 UDP 触发会停止，改为运行新配置。切换过程中约几百毫秒内不会执行任何事件。',
  });
  return r.response === 0;
}

async function showError(d: ProjectDeps, message: string, detail?: string): Promise<void> {
  if (d.noPrompt) return;
  await box(d.getWindow(), { type: 'error', message, detail, buttons: ['好'] });
}

/** 打开配置。file 不给就弹出选择框。返回是否成功切换。 */
export async function openProject(d: ProjectDeps, file?: string): Promise<boolean> {
  const client = d.getClient();
  if (!client) return false;
  let target = file;
  if (!target) {
    const win = d.getWindow();
    const r = await (win && win.isVisible()
      ? dialog.showOpenDialog(win, { title: '打开配置', properties: ['openFile'], filters: FILTERS })
      : dialog.showOpenDialog({ title: '打开配置', properties: ['openFile'], filters: FILTERS }));
    if (r.canceled || !r.filePaths[0]) return false;
    target = r.filePaths[0];
  }
  if (target === d.currentFile()) return false;
  if (!(await confirmSwitch(d, target))) return false;
  try {
    await client.request('openProject', { file: target });
    return true;
  } catch (e) {
    if (e instanceof RpcError && e.code === 'invalid-project') {
      const issues = (e.details as Issue[]).filter((i) => i.level === 'error');
      const detail = issues.slice(0, 8).map((i) => `• [${i.path}] ${i.message}`).join('\n') + (issues.length > 8 ? `\n…还有 ${issues.length - 8} 个` : '');
      const r = d.noPrompt
        ? { response: 0 }
        : await box(d.getWindow(), {
            type: 'warning',
            buttons: ['仍然打开（引擎将不运行）', '取消'],
            defaultId: 1,
            cancelId: 1,
            message: '该配置有错误',
            detail: `${detail}\n\n仍然打开的话，修复并保存之前引擎不会运行，当前日程会停止。`,
          });
      if (r.response !== 0) return false;
      await client.request('openProject', { file: target, force: true });
      return true;
    }
    await showError(d, '无法打开配置', (e as Error).message);
    return false;
  }
}

/** 新建配置：选保存位置 → 创建空项目 → 切换过去。file 不给就弹出保存框。 */
export async function newProject(d: ProjectDeps, file?: string): Promise<boolean> {
  const client = d.getClient();
  if (!client) return false;
  let target = file;
  if (!target) {
    const win = d.getWindow();
    const opts = {
      title: '新建配置',
      defaultPath: path.join(app.getPath('documents'), 'CueClock', '新配置.cueclock.json'),
      filters: FILTERS,
    };
    const r = await (win && win.isVisible() ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts));
    if (r.canceled || !r.filePath) return false;
    target = r.filePath;
  }
  if (!(await confirmSwitch(d, target))) return false;
  try {
    await client.request('newProject', { file: target });
    return true;
  } catch (e) {
    await showError(d, '无法新建配置', (e as Error).message);
    return false;
  }
}

export function revealProject(file: string | null): void {
  if (file) shell.showItemInFolder(file);
}
