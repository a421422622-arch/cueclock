import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// macOS 开机自启：在 ~/Library/LaunchAgents 放一个 LaunchAgent，登录时拉起界面（--hidden，只在菜单栏）。
// 不依赖安装包：开发版也能用（登记的是 Electron 本体 + 本目录），所以这里不用 Electron 的登录项 API。
// 默认不设 KeepAlive；可选守护仅在异常退出后拉起，正常退出尊重操作者意图。

export const LAUNCH_AGENT_LABEL = 'com.cueclock.app';

export const launchAgentPath = (home: string): string => path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function buildLaunchAgentPlist(args: string[], guard = false): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
${guard ? `  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
` : ''}  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

const unesc = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

export interface AutostartState {
  enabled: boolean;
  /** 已登记但指向的程序已不存在（软件被移动或删除） */
  stale: boolean;
  guardEnabled?: boolean;
}

export async function readLaunchAgent(home: string): Promise<AutostartState> {
  const file = launchAgentPath(home);
  if (!existsSync(file)) return { enabled: false, stale: false };
  try {
    const xml = await readFile(file, 'utf8');
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? '';
    const first = /<string>([\s\S]*?)<\/string>/.exec(block)?.[1];
    return { enabled: true, stale: first ? !existsSync(unesc(first)) : true, ...(/<key>KeepAlive<\/key>/.test(xml) ? { guardEnabled: true } : {}) };
  } catch {
    return { enabled: true, stale: true };
  }
}

export async function enableLaunchAgent(home: string, args: string[], guard = false): Promise<void> {
  const file = launchAgentPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buildLaunchAgentPlist(args, guard), { mode: 0o644 });
}

export async function disableLaunchAgent(home: string): Promise<void> {
  await rm(launchAgentPath(home), { force: true });
}
