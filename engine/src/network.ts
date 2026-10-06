import os from 'node:os';

export interface NicInfo {
  name: string;
  address: string;
  netmask: string;
  /** 前缀长度，如 255.255.255.0 → 24 */
  cidr: number;
  internal: boolean;
  mac: string;
}

/** 机器级网络设置：跟这台电脑绑定，不写进项目文件。 */
export interface NetworkSettings {
  /**
   * 发送用的本机网卡 IPv4（可多选）；不填 = 由系统按路由选择。
   * 每块网卡一个发送套接字，发给某个目标时按"目标落在哪个子网"选网卡。
   */
  localAddresses?: string[];
  /** 发送固定的本地端口；不填 = 随机。回包从这个端口收，固定后便于防火墙放行 */
  localPort?: number;
  /** 触发器监听所有网卡；默认只监听所选网卡 */
  listenAll?: boolean;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const isIPv4 = (s: string): boolean => {
  const m = IPV4.exec(s);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
};

const cidrOf = (mask: string): number =>
  mask.split('.').reduce((n, p) => n + Number(p).toString(2).split('1').length - 1, 0);

/** 本机的 IPv4 网卡地址。物理网卡在前，回环在后。 */
export function listInterfaces(raw: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): NicInfo[] {
  const out: NicInfo[] = [];
  for (const [name, infos] of Object.entries(raw)) {
    for (const i of infos ?? []) {
      // 老版本 Node 的 family 是数字 4，新版本是 'IPv4'
      if (String(i.family) !== 'IPv4' && String(i.family) !== '4') continue;
      out.push({ name, address: i.address, netmask: i.netmask, cidr: cidrOf(i.netmask), internal: i.internal, mac: i.mac });
    }
  }
  return out.sort((a, b) => Number(a.internal) - Number(b.internal) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

/** 校验并规范化用户提交的网络设置；空/0.0.0.0/0 都表示"自动"。兼容旧的单个 localAddress。 */
export function parseNetwork(input: unknown): NetworkSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('网络设置必须是对象');
  const r = input as Record<string, unknown>;
  const out: NetworkSettings = {};
  const raw: unknown[] = [];
  if (r.localAddresses !== undefined && r.localAddresses !== null) {
    if (!Array.isArray(r.localAddresses)) throw new Error('localAddresses 必须是数组');
    raw.push(...r.localAddresses);
  }
  if (typeof r.localAddress === 'string') raw.push(r.localAddress); // 旧格式
  const addrs: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') throw new Error('本机网卡 IP 必须是字符串');
    const a = v.trim();
    if (!a || a === '0.0.0.0') continue;
    if (!isIPv4(a)) throw new Error(`本机网卡 IP "${a}" 不是合法的 IPv4 地址`);
    if (!addrs.includes(a)) addrs.push(a);
  }
  if (addrs.length > 0) out.localAddresses = addrs;
  if (r.localPort !== undefined && r.localPort !== null && r.localPort !== 0 && r.localPort !== '') {
    const p = Number(r.localPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`本地源端口 ${String(r.localPort)} 非法（1-65535，或留空自动）`);
    out.localPort = p;
  }
  if (r.listenAll === true) out.listenAll = true;
  return out;
}

/** 配置的网卡地址里，本机当前没有的那些。 */
export function missingAddresses(addrs: string[] | undefined, nics: NicInfo[] = listInterfaces()): string[] {
  return (addrs ?? []).filter((a) => !nics.some((n) => n.address === a));
}

function ipInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  return (((+m[1]! << 24) | (+m[2]! << 16) | (+m[3]! << 8) | +m[4]!) >>> 0);
}

/**
 * 发给 dest 时用哪块（些）本机网卡。规则：
 *  1. 指定了 preferred 且在已绑定的网卡里 → 就用它
 *  2. 受限广播 255.255.255.255 → 每块网卡各发一次
 *  3. 目标落在哪块网卡的子网里就用哪块，多块匹配取前缀最长的
 *  4. 都不匹配 → 第一块（之后由系统路由表决定实际出口）
 * locals 为空（没绑定任何网卡）时返回空数组。cidr 为 0 的（"自动"套接字）不参与子网匹配。
 */
export function chooseLocal(dest: string, locals: { address: string; cidr: number }[], preferred?: string): string[] {
  if (locals.length === 0) return [];
  if (preferred && locals.some((l) => l.address === preferred)) return [preferred];
  if (dest === '255.255.255.255') return locals.map((l) => l.address);
  const d = ipInt(dest);
  let best = -1;
  let pick: string | undefined;
  for (const l of locals) {
    const a = ipInt(l.address);
    if (d === null || a === null || l.cidr <= 0) continue;
    const mask = (0xffffffff << (32 - l.cidr)) >>> 0;
    if (((a & mask) >>> 0) === ((d & mask) >>> 0) && l.cidr > best) {
      best = l.cidr;
      pick = l.address;
    }
  }
  return [pick ?? locals[0]!.address];
}
