// 正式部署（macOS）：把当前构建复制成不在「文稿」目录里的独立版本，并切换登录守护。
//
//   node scripts/release.mjs build            构建 → 复制到 ~/CueClock-run/releases/<版本>-<构建>/ → 用独立端口/状态目录自检
//   node scripts/release.mjs switch <版本目录>  备份正式数据 → 记录现场 → 写登录项（异常退出自动拉起）→ 停旧引擎 → 由新版本接管 47800
//   node scripts/release.mjs status           查看正式引擎与登录项
//
// 设计依据见 deliverables/Mac部署与守护验收.md：版本目录不覆盖、数据仍在 ~/Library/Application Support/CueClock、
// 47800 只能有一个正式引擎；切换前记录项目 / 暂停 / 接管状态，切换后逐项核对；旧版本目录与数据备份保留用于回滚。
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../engine/src/client.ts';
import { defaultStateDir } from '../../engine/src/paths.ts';
import { buildLaunchAgentPlist, launchAgentPath, LAUNCH_AGENT_LABEL } from '../electron/autostartMac.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const runRoot = path.join(os.homedir(), 'CueClock-run');
const releases = path.join(runRoot, 'releases');
const electronApp = path.join(appDir, 'node_modules/electron/dist/Electron.app');
const stateDir = defaultStateDir();
const domain = `gui/${process.getuid()}`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const sha = async (f) => createHash('sha256').update(await readFile(f)).digest('hex');
const exists = (f) => access(f).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : null;
    child.on('close', (code) => { if (timer) clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} 退出 ${code}\n${out.slice(-2000)}`)); });
  });
}

async function engineStatus(dir) {
  const client = DaemonClient.forStateDir(dir);
  try { await client.connect(); return await client.request('status'); } finally { client.close(); }
}
const tryStatus = (dir) => engineStatus(dir).catch(() => null);
const releaseBinary = (dir) => path.join(dir, 'Electron.app/Contents/MacOS/Electron');
const releaseAppDir = (dir) => path.join(dir, 'app');

async function freePort() {
  const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address(); await new Promise((r) => server.close(r)); return port;
}

async function build() {
  console.log('· 构建…');
  await run('npm', ['run', 'build'], { cwd: appDir, timeout: 300000 });
  // 先在临时目录拼好，校验通过后才改名成正式版本目录，避免留下半个版本
  await mkdir(releases, { recursive: true });
  const staging = await mkdtemp(path.join(releases, '.staging-'));
  try {
    await cp(electronApp, path.join(staging, 'Electron.app'), { recursive: true, verbatimSymlinks: true });
    const target = releaseAppDir(staging);
    await mkdir(target, { recursive: true });
    await cp(path.join(appDir, 'dist'), path.join(target, 'dist'), { recursive: true });
    await cp(path.join(appDir, 'assets'), path.join(target, 'assets'), { recursive: true });
    await cp(path.join(appDir, 'package.json'), path.join(target, 'package.json'));
    for (const f of ['dist/electron/main.cjs', 'dist/electron/preload.cjs', 'dist/engine/cli.mjs']) {
      if (await sha(path.join(appDir, f)) !== await sha(path.join(target, f))) fail(`复制校验失败：${f}`);
    }
    // 独立端口 + 独立状态目录自检：拉起新版本引擎并连接，读出版本与构建号
    const port = await freePort();
    if (port === 47800) fail('自检端口不能是 47800');
    const smokeState = await mkdtemp(path.join(os.tmpdir(), 'cueclock-release-smoke-'));
    const project = path.join(smokeState, 'project.json');
    await writeFile(project, JSON.stringify({ name: '发布自检', devices: [], groups: [], timelines: [], triggers: [], settings: { recovery: { enabled: false } } }));
    const env = { ...process.env, CUECLOCK_HOME: smokeState, CUECLOCK_AUTOSTART_HOME: path.join(smokeState, 'login-home') };
    delete env.ELECTRON_RUN_AS_NODE;
    const out = await run(releaseBinary(staging), [target, '--smoke-test', '--daemon-port', String(port), '--state-dir', smokeState, '--project', project], { env, timeout: 90000 });
    // --smoke-test 按设计会让它拉起的引擎留在后台（正式使用时界面退出不停引擎），自检完要停掉
    const smokeEngine = await tryStatus(smokeState);
    if (smokeEngine) { const c = DaemonClient.forStateDir(smokeState); await c.connect(); await c.request('shutdown').catch(() => {}); c.close(); }
    for (let i = 0; i < 25 && await tryStatus(smokeState); i++) await sleep(200);
    if (!out.includes('SMOKE_OK engine.running=true')) fail(`新版本自检未通过：\n${out}`);
    // 再直接起一次副本里的引擎，读它自报的版本与构建号（同时验证复制出来的引擎包本身能跑）
    const engineState = path.join(smokeState, 'engine-only');
    const daemon = spawn(releaseBinary(staging), [path.join(target, 'dist/engine/cli.mjs'), 'daemon', project, '--port', String(await freePort()), '--state-dir', engineState],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
    let hello = null;
    for (let i = 0; i < 50 && !hello; i++) { await sleep(200); hello = await tryStatus(engineState); }
    if (hello) { const c = DaemonClient.forStateDir(engineState); await c.connect(); await c.request('shutdown').catch(() => {}); c.close(); }
    await sleep(300); daemon.kill();
    await rm(smokeState, { recursive: true, force: true });
    if (!hello?.engineVersion || !hello.engineBuild) fail('读不到副本引擎的版本信息');
    // 目录名带时间：只改界面时引擎构建号不变，不能因为「同名已存在」就跳过新界面
    const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appDir }).toString().trim(); } catch { return null; } })();
    const dirty = (() => { try { return execFileSync('git', ['status', '--porcelain'], { cwd: appDir }).toString().trim() !== ''; } catch { return null; } })();
    const name = `${hello.engineVersion}-${stamp()}`;
    const final = path.join(releases, name);
    await writeFile(path.join(staging, 'release.json'), JSON.stringify({ engineVersion: hello.engineVersion, engineBuild: hello.engineBuild, builtAt: new Date().toISOString(), commit, uncommittedChanges: dirty }, null, 2));
    await run('mv', [staging, final]);
    console.log(`✓ 新版本：${final}\n  引擎 ${hello.engineVersion} · 构建 ${hello.engineBuild} · 代码 ${commit ?? '未知'}${dirty ? '（含未提交改动）' : ''} · 独立自检通过（端口 ${port}）`);
    return final;
  } catch (e) { await rm(staging, { recursive: true, force: true }); throw e; }
}

function launchctl(...args) {
  try { return execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { return null; }
}
const jobInfo = () => launchctl('print', `${domain}/${LAUNCH_AGENT_LABEL}`);
const jobPid = () => Number(/\bpid = (\d+)/.exec(jobInfo() ?? '')?.[1] ?? 0) || null;

async function switchTo(dir) {
  dir = path.resolve(dir);
  if (path.dirname(dir) !== releases) fail(`只允许切换到 ${releases} 下的版本目录`);
  if (!(await exists(releaseBinary(dir))) || !(await exists(path.join(releaseAppDir(dir), 'package.json')))) fail('版本目录不完整');
  const meta = JSON.parse(await readFile(path.join(dir, 'release.json'), 'utf8').catch(() => 'null'));
  if (!meta?.engineBuild) fail('版本目录缺少 release.json（请用 build 生成）');
  const before = await tryStatus(stateDir);
  // 引擎构建没变（只改了界面）：不停引擎，只换界面，新界面会接管正在运行的引擎
  const keepEngine = !!before && before.engineBuild === meta.engineBuild;
  const ts = stamp();
  // 1. 数据备份（项目、机器设置、日志），与版本目录分开存
  const backup = path.join(runRoot, 'backups', `${ts}-切换前`);
  await mkdir(path.dirname(backup), { recursive: true });
  await cp(stateDir, backup, { recursive: true, verbatimSymlinks: true });
  const record = { at: new Date().toISOString(), target: dir, backup, release: meta,
    before: before && { version: before.engineVersion, build: before.engineBuild, pid: before.daemon.pid, rev: before.daemon.rev, projectFile: before.daemon.projectFile,
      paused: before.engine?.paused, running: before.engine?.running, overrides: (before.engine?.devices ?? []).filter((d) => d.override).map((d) => d.id),
      inFlight: before.engine?.inFlight?.length ?? null } };
  await writeFile(path.join(backup, '切换记录.json'), JSON.stringify(record, null, 2));
  console.log(`· 已备份正式数据：${backup}`);
  if (before?.engine?.inFlight?.length) fail(`现在有 ${before.engine.inFlight.length} 个动作链正在执行，请等它们结束再切换`);
  // 2. 登录项：开机启动 + 异常退出自动拉起（正常退出不拉）；参数与「设置」里勾选的完全相同
  const plistFile = launchAgentPath(os.homedir());
  const oldPlist = await readFile(plistFile, 'utf8').catch(() => null);
  if (oldPlist) await writeFile(path.join(backup, `${LAUNCH_AGENT_LABEL}.plist`), oldPlist);
  await mkdir(path.dirname(plistFile), { recursive: true });
  await writeFile(plistFile, buildLaunchAgentPlist([releaseBinary(dir), releaseAppDir(dir), '--hidden'], true), { mode: 0o644 });
  // 3. 停掉旧的：登录项里的旧界面（若有），再让旧引擎优雅退出
  const oldUi = jobPid();
  if (jobInfo()) {
    launchctl('bootout', `${domain}/${LAUNCH_AGENT_LABEL}`);
    // bootout 是异步的：任务注销、旧界面退出之后才能重新 bootstrap，否则会被拒绝（实测）
    for (let i = 0; i < 100 && (jobInfo() || (oldUi && alive(oldUi))); i++) await sleep(200);
    if (jobInfo()) fail('旧登录项没有注销，已停止切换');
  }
  if (keepEngine) console.log(`· 引擎构建相同（${meta.engineBuild}），保留正在运行的引擎 PID ${before.daemon.pid}，只更换界面`);
  else if (before) {
    const client = DaemonClient.forStateDir(stateDir); await client.connect();
    await client.request('shutdown').catch(() => {}); client.close();
    for (let i = 0; i < 50 && await tryStatus(stateDir); i++) await sleep(200);
    if (await tryStatus(stateDir)) fail('旧引擎没有退出，已停止切换（登录项已写好但未加载）');
    console.log(`· 旧引擎已退出（${before.engineVersion}，PID ${before.daemon.pid}）`);
  }
  // 4. 由登录守护拉起新界面，界面再拉起新引擎
  let loaded = false;
  for (let i = 0; i < 10 && !loaded; i++) { loaded = launchctl('bootstrap', domain, plistFile) !== null; if (!loaded) await sleep(500); }
  if (!loaded) fail(`launchctl bootstrap 失败；可手动执行：launchctl bootstrap ${domain} "${plistFile}"`);
  let after = null;
  for (let i = 0; i < 150; i++) {
    after = await tryStatus(stateDir);
    if (after?.engine?.running && (keepEngine ? jobPid() : after.daemon.pid !== before?.daemon.pid)) break;
    await sleep(200);
  }
  if (!after?.engine?.running) fail('新引擎未在 30 秒内就绪，请查看日志');
  const checks = {
    version: after.engineVersion, build: after.engineBuild, pid: after.daemon.pid, uiPid: jobPid(),
    sameProject: after.daemon.projectFile === record.before?.projectFile,
    pausedKept: record.before ? after.engine.paused === record.before.paused : null,
    overridesKept: record.before ? JSON.stringify((after.engine.devices ?? []).filter((d) => d.override).map((d) => d.id)) === JSON.stringify(record.before.overrides) : null,
    guard: /KeepAlive/.test(await readFile(plistFile, 'utf8')),
  };
  record.after = checks;
  await writeFile(path.join(backup, '切换记录.json'), JSON.stringify(record, null, 2));
  console.log(`✓ 已切换：引擎 ${checks.version} · 构建 ${checks.build} · 引擎 PID ${checks.pid} · 界面 PID ${checks.uiPid}`);
  console.log(`  项目一致 ${checks.sameProject} · 暂停状态保留 ${checks.pausedKept} · 接管保留 ${checks.overridesKept} · 异常退出守护 ${checks.guard}`);
  console.log(`  回滚：launchctl bootout ${domain}/${LAUNCH_AGENT_LABEL}；用备份里的 plist / 数据恢复后重新 bootstrap（见 ${path.join(backup, '切换记录.json')}）`);
  if (!checks.sameProject || checks.pausedKept === false || checks.overridesKept === false) process.exitCode = 2;
}

async function status() {
  const st = await tryStatus(stateDir);
  console.log(st ? `正式引擎：${st.engineVersion} · 构建 ${st.engineBuild} · PID ${st.daemon.pid} · ${st.engine?.paused ? '已暂停' : '运行中'} · ${st.daemon.projectFile}` : '正式引擎：未运行');
  const plist = await readFile(launchAgentPath(os.homedir()), 'utf8').catch(() => null);
  console.log(plist ? `登录项：${/<string>([^<]+)<\/string>/.exec(plist.split('ProgramArguments')[1] ?? '')?.[1]} · 守护 ${/KeepAlive/.test(plist)} · 当前${jobPid() ? `运行中 PID ${jobPid()}` : '未运行'}` : '登录项：未设置');
}

const [cmd, arg] = process.argv.slice(2);
if (process.platform !== 'darwin') fail('目前只支持 macOS');
if (cmd === 'build') await build();
else if (cmd === 'switch' && arg) await switchTo(arg);
else if (cmd === 'status') await status();
else fail('用法：node scripts/release.mjs build | switch <版本目录> | status');
