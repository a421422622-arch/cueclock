import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../engine/src/client.ts';
import { defaultStateDir } from '../../engine/src/paths.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const evidence = path.join(root, '.codex-work', `${stamp}-独立验收`);
const base = path.join(os.tmpdir(), 'codex', 'UDP中控时间线', '独立验收');
await Promise.all([mkdir(evidence, { recursive: true }), mkdir(base, { recursive: true })]);
const temporary = await mkdtemp(path.join(base, 'run-'));
const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
delete env.ELECTRON_RUN_AS_NODE; delete env.CUECLOCK_DEV_URL;
const results = [], daemons = [];
let protectedPid = null;
try { protectedPid = JSON.parse(await readFile(path.join(defaultStateDir(true), 'daemon.json'), 'utf8')).pid; } catch {}

function execute(name, binary, args, cwd, overrides = {}, timeout = 90000) {
  return new Promise((resolve, reject) => {
    // Windows 上 npm 是 npm.cmd，需要经过 shell；其他可执行文件（Electron）直接启动
    const child = spawn(binary, args, { cwd, env: { ...env, ...overrides }, windowsHide: true, shell: process.platform === 'win32' && binary === 'npm' });
    let output = '';
    child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      await writeFile(path.join(evidence, `${name}.log`), output);
      results.push({ name, exitCode: code });
      console.log(`${name}: ${code === 0 ? 'PASS' : 'FAIL'}`);
      if (code !== 0) reject(new Error(`${name} 失败，日志：${evidence}`)); else resolve(output);
    });
  });
}

async function freePort() {
  const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise((r) => server.close(r));
  if (port === 47800) return freePort(); return port;
}

async function cleanup({ state, port }) {
  let info;
  try { info = JSON.parse(await readFile(path.join(state, 'daemon.json'), 'utf8')); } catch { return; }
  const relative = path.relative(temporary, state);
  if (relative.startsWith('..') || path.isAbsolute(relative) || info.port !== port || info.pid === protectedPid || port === 47800) throw new Error('拒绝清理不属于本次验收的引擎');
  const client = DaemonClient.forStateDir(state);
  try { await client.connect(); await client.request('shutdown'); } finally { client.close(); }
  for (let n = 0; n < 100; n++) {
    try { await readFile(path.join(state, 'daemon.json')); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('测试引擎未退出，请检查保留的临时目录');
}

let success = false;
try {
  // Windows 默认仍拒绝（尚未在用户的现场电脑上验证）；GitHub Actions 的 windows 工作流设置 CUECLOCK_WINDOWS_VERIFY=1 才放行，用来在真实 Windows 上摸底
  if (process.platform === 'win32' && process.env.CUECLOCK_WINDOWS_VERIFY !== '1') throw new Error('此自动验收入口尚未在Windows验证；请按交接手册进行Windows现场验收（或设置 CUECLOCK_WINDOWS_VERIFY=1 自担风险试跑）');
  await execute('engine-test', 'npm', ['test'], path.join(root, 'engine'));
  await execute('engine-types', 'npm', ['run', 'typecheck'], path.join(root, 'engine'));
  await execute('app-test', 'npm', ['test'], path.join(root, 'app'));
  await execute('app-types', 'npm', ['run', 'typecheck'], path.join(root, 'app'));
  await execute('build', 'npm', ['run', 'build'], path.join(root, 'app'));
  const binary = process.platform === 'darwin' ? path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, process.platform === 'win32' ? 'app/node_modules/electron/dist/electron.exe' : 'app/node_modules/electron/dist/electron');
  for (const mode of ['smoke-test', 'smoke-ui', 'smoke-app']) {
    const folder = path.join(temporary, mode), state = path.join(folder, 'state'), port = await freePort();
    await mkdir(folder, { recursive: true });
    const project = JSON.parse(await readFile(path.join(root, 'engine/data/sample-project.json'), 'utf8'));
    project.triggers = []; project.settings = { localAddress: '127.0.0.1', recovery: { enabled: false } };
    for (const d of project.devices) { d.ip = '127.0.0.1'; delete d.health; }
    for (const t of project.timelines) for (const c of t.cues) c.enabled = false;
    const file = path.join(folder, 'project.json'); await writeFile(file, JSON.stringify(project));
    const record = { state, port }; daemons.push(record);
    const args = [path.join(root, 'app/dist/electron/main.cjs'), `--${mode}`, '--daemon-port', String(port), '--state-dir', state, '--project', file];
    if (mode === 'smoke-ui') args.push('--screenshot', path.join(evidence, 'smoke-ui.png'), '--clipping-dir', path.join(evidence, 'clipping'));
    const output = await execute(mode, binary, args, root, { CUECLOCK_HOME: state, CUECLOCK_AUTOSTART_HOME: path.join(folder, 'login-home') }, 60000);
    if (mode === 'smoke-test') {
      if (!output.includes('SMOKE_OK engine.running=true')) throw new Error('引擎冒烟结果未确认');
    } else {
      const prefix = mode === 'smoke-ui' ? 'SMOKE_UI ' : 'SMOKE_APP ';
      const line = output.split('\n').find((s) => s.startsWith(prefix));
      const result = line && JSON.parse(line.slice(prefix.length));
      if (!result || mode === 'smoke-ui' && (!result.ready || !result.overview || !result.runtimeConfiguration?.passed || !result.logPerformance?.passed || result.logPerformance?.samples?.length !== 4 || result.clipping?.passed !== true || !result.clipping?.negativeControl?.rejected || !result.clipping?.negativeControl?.verticalRejected || !result.clipping?.negativeControl?.zeroColumnRejected || result.clipping?.checks?.length !== 58 || Object.values(result.layout ?? {}).some((x) => !x || x.overflow !== false || x.overlap !== false)) || mode === 'smoke-app' && (!result.restarted || !result.engineStopped || !result.viewMenu?.includes('恢复默认界面布局'))) throw new Error(`${mode} 行为检查未通过`);
    }
    await cleanup(record);
  }
  success = true;
} finally {
  let clean = true;
  for (const d of daemons) try { await cleanup(d); } catch (e) { clean = false; console.error(e.message); }
  let afterPid = null;
  try { afterPid = JSON.parse(await readFile(path.join(defaultStateDir(true), 'daemon.json'), 'utf8')).pid; } catch {}
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ success, clean, results, productionEngine: { beforePid: protectedPid, afterPid }, temporary: clean ? '已清理' : temporary }, null, 2));
  if (clean) await rm(temporary, { recursive: true, force: true });
  console.log(`验收证据：${evidence}`);
  if (!success || !clean) process.exitCode = 1;
}
