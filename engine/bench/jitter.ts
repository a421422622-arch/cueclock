// 抖动实测：N 个随机毫秒点，真实时钟 + 真实 UDP（本机回环），统计 计划时间 → 设备收到 的误差。
// 用法：node bench/jitter.ts [个数=100] [时长秒=6]
import dgram from 'node:dgram';
import { Engine } from '../src/engine.ts';
import { formatTime } from '../src/time.ts';
import type { Project } from '../src/types.ts';

const N = Number(process.argv[2] ?? 100);
const SPAN = Number(process.argv[3] ?? 6) * 1000;

const sock = dgram.createSocket('udp4');
await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
const port = sock.address().port;

const now = new Date();
const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const base = Date.now() + 1500; // 1.5 秒后开始
if (base + SPAN > midnight + 86_400_000 - 2000) throw new Error('太接近午夜，请稍后再试');

const planned = new Map<string, number>();
const cues = Array.from({ length: N }, (_, i) => {
  const t = base + Math.floor(Math.random() * SPAN);
  planned.set(`c${i}`, t);
  return {
    id: `c${i}`, name: `c${i}`, time: formatTime(t - midnight),
    actions: [{ id: 'a', type: 'udp' as const, targets: ['D'], format: 'ascii' as const, payload: `c${i}` }],
  };
});
const project: Project = {
  name: 'jitter', groups: [], triggers: [],
  devices: [{ id: 'D', name: 'D', ip: '127.0.0.1', port }],
  timelines: [{ id: 't', name: 't', cues }],
  settings: { localAddress: '127.0.0.1', recovery: { enabled: false } },
};

const errs: number[] = [];
sock.on('message', (m) => {
  const t = planned.get(m.toString());
  if (t !== undefined) errs.push(Date.now() - t);
});

const e = new Engine(project);
await e.start();
await new Promise((r) => setTimeout(r, base + SPAN - Date.now() + 500));
await e.stop();
sock.close();

errs.sort((a, b) => a - b);
const q = (p: number) => errs[Math.min(errs.length - 1, Math.floor(errs.length * p))]!;
console.log(`收到 ${errs.length}/${N} 个包；误差(ms，设备收到时刻 - 计划时刻)：` +
  `最小 ${errs[0]}  中位 ${q(0.5)}  P95 ${q(0.95)}  P99 ${q(0.99)}  最大 ${errs[errs.length - 1]}`);
