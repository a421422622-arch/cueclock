import { spawn } from 'node:child_process';
import { isIPv4 } from './network.ts';

export interface PingResult {
  ok: boolean;
  rttMs?: number;
  error?: string;
}

/**
 * 各平台 ping 的参数：只发 1 个包。注意单位不同——macOS 的 -W 是毫秒，Linux 的 -W 是秒，Windows 的 -w 是毫秒。
 * 参数用数组传给 spawn，不经过 shell，配合严格的 IPv4 校验，不可能被注入。
 */
export function pingArgs(platform: NodeJS.Platform, ip: string, timeoutMs: number): string[] {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), ip];
  if (platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), ip];
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];
}

/**
 * 判定是否收到应答：只认输出里的 TTL（中英文系统都是 "TTL=64"/"ttl=64"）。
 * 不能只看退出码——Windows 上对方不可达时，由网关回的“无法访问目标主机”有时也是退出码 0。
 * 为不依赖语言，不解析其他文字。
 */
export function parsePing(output: string): PingResult {
  if (!/ttl\s*[=:]\s*\d+/i.test(output)) return { ok: false };
  const m = /time\s*[=<]\s*([\d.]+)/i.exec(output);
  return { ok: true, ...(m ? { rttMs: Math.round(Number(m[1]) * 10) / 10 } : {}) };
}

/** 调系统 ping 命令检测 IPv4 主机是否可达。只说明网络层通不通，不代表设备上的程序正常。 */
export function systemPing(ip: string, timeoutMs: number, platform: NodeJS.Platform = process.platform): Promise<PingResult> {
  if (typeof ip !== 'string' || !isIPv4(ip)) return Promise.resolve({ ok: false, error: '不是合法的 IPv4 地址' });
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: PingResult) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ping', pingArgs(platform, ip, timeoutMs), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve({ ok: false, error: '无法运行系统 ping 命令' });
    }
    // 兜底：命令自己的超时没生效时，强制结束，绝不让检测卡住
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false });
    }, timeoutMs + 1500);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code === 'ENOENT' ? '找不到系统 ping 命令' : e.message }));
    child.on('close', () => finish(parsePing(out)));
  });
}

/** 由设备 id 得到一个稳定的、0~3999ms 的错开量：多台设备的探测不要同一瞬间一起发。 */
export function staggerMs(id: string): number {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return (sum * 997) % 4000;
}
