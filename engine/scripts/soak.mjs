// 真实时间压力测试：独立端口/状态目录，不碰 47800。用法：node engine/scripts/soak.mjs <秒数>（默认 300）。40 台设备 Ping + 每 5 秒事件发给 5 台 + 每秒约 50 个触发包，输出内存 / CPU / 丢包 / 错误日志。
import { spawn, execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { DaemonClient } from '../src/client.ts';
const SECS = Number(process.argv[2] ?? 300), PORT = 47941, SINK = 9200, TRIG = 9201;
const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-soak-')); const state = path.join(dir, 'state');
const pad = (n) => String(n).padStart(2, '0'); const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const devices = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, name: `设备${i}`, ip: '127.0.0.1', port: SINK, format: 'ascii', terminator: 'none', health: { mode: 'ping', intervalSec: 10 } }));
const start = Date.now() + 8000;
const cues = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, name: `事件${i}`, time: hms(new Date(start + i * 5000)),
  actions: [{ id: `a${i}`, type: 'udp', targets: Array.from({ length: 5 }, (_, k) => `d${(i * 5 + k) % 40}`), format: 'ascii', payload: `CUE ${i}`, repeat: 2, repeatGapMs: 100 }] }));
const project = { name: '压力测试', devices, groups: [], timelines: [{ id: 't', name: '压力', cues }],
  triggers: [{ id: 'tr', name: '触发', port: TRIG, allowFrom: ['*'], match: { kind: 'prefix', format: 'ascii', pattern: 'GO' }, debounceMs: 0, actions: [{ id: 'ta', type: 'udp', targets: ['d0'], format: 'ascii', payload: 'TRIGGERED' }] }],
  settings: { recovery: { enabled: false } } };
await writeFile(path.join(dir, 'p.json'), JSON.stringify(project));
const sink = dgram.createSocket('udp4'); let got = 0; sink.on('message', () => got++); await new Promise((r) => sink.bind(SINK, '127.0.0.1', r));
const eng = spawn(process.execPath, ['--no-warnings', path.resolve(import.meta.dirname, '../src/cli.ts'), 'daemon', path.join(dir, 'p.json'), '--port', String(PORT), '--state-dir', state], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const client = DaemonClient.forStateDir(state); await client.connect();
let logEvents = 0; client.on('log', () => logEvents++);
const flood = dgram.createSocket('udp4'); let sent = 0; const fl = setInterval(() => { flood.send('GO now', TRIG, '127.0.0.1'); sent++; }, 20);
const rows = []; const t0 = Date.now(); let maxStatusMs = 0;
const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(eng.pid)]).toString().trim()) / 1024;
const cpu = () => Number(execFileSync('ps', ['-o', '%cpu=', '-p', String(eng.pid)]).toString().trim());
const children = () => Number(execFileSync('sh', ['-c', `pgrep -P ${eng.pid} | wc -l`]).toString().trim());
while (Date.now() - t0 < SECS * 1000) {
  const a = Date.now(); const st = await client.request('status'); maxStatusMs = Math.max(maxStatusMs, Date.now() - a);
  rows.push({ s: Math.round((Date.now() - t0) / 1000), rssMB: Math.round(rss()), cpu: cpu(), children: children(), sink: got, trig: sent, logEvents, healthy: st.engine.devices.filter((d) => d.state === 'online').length });
  await new Promise((r) => setTimeout(r, 5000));
}
clearInterval(fl);
const logs = await client.request('getLogs', { limit: 2000 });
const errs = logs.filter((l) => l.result === 'error').length;
client.close(); await client.request?.('shutdown').catch(() => {}); eng.kill('SIGTERM'); sink.close(); flood.close();
const first = rows[2] ?? rows[0], last = rows.at(-1);
console.log(JSON.stringify({ secs: SECS, samples: rows.length, rssStartMB: first.rssMB, rssEndMB: last.rssMB, rssMaxMB: Math.max(...rows.map((r) => r.rssMB)), cpuAvg: Math.round(rows.reduce((a, r) => a + r.cpu, 0) / rows.length * 10) / 10, cpuMax: Math.max(...rows.map((r) => r.cpu)), maxChildProcs: Math.max(...rows.map((r) => r.children)), udpReceived: got, triggerPacketsSent: sent, logEventsToClient: logEvents, maxStatusLatencyMs: maxStatusMs, onlineDevicesEnd: last.healthy, errorLogs: errs }, null, 1));
console.log(rows.filter((_, i) => i % 6 === 0).map((r) => `${r.s}s rss=${r.rssMB}MB cpu=${r.cpu}% ping子进程=${r.children} 收到UDP=${r.sink} 在线=${r.healthy}`).join('\n'));
await rm(dir, { recursive: true, force: true }); process.exit(0);
