// 打包 Windows 版（免安装文件夹 + zip）。可以在 macOS / Linux / Windows 上运行：
//
//   cd app && npm ci           # 只需第一次
//   node ../windows/build-windows.mjs
//
// 产物：windows/dist/CueClock-<引擎版本>-win-x64.zip（解压后双击 CueClock.exe）。
// 做了什么：构建界面与引擎（esbuild + vite，和 macOS 同一份代码）→ 只挑运行需要的文件放进暂存目录 →
//           用 @electron/packager 套上 Windows 版 Electron 运行时 → 补上使用说明 → 压成 zip。
// 说明：在 Windows 上构建时（GitHub Actions）会写入 exe 的图标和版本信息（公司 / 版权 = Fawen）；在 macOS / Linux 上交叉打包则跳过这一步（需要 wine）。
//       环境变量 CUECLOCK_SIGN_PFX_BASE64 + CUECLOCK_SIGN_PFX_PASSWORD 都设置且在 Windows 上构建时，会用 windows/sign.ps1 把 CueClock.exe 签名为「Fawen」（自签名证书，见 windows/README.md）。
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const app = path.join(repo, 'app');
const out = path.join(here, 'dist');
const stage = path.join(out, 'stage');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
// Windows 上经 shell 启动（npm.cmd / npx.cmd），含空格或特殊字符的参数必须自己加引号
const quote = (a) => (isWin && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, isWin ? args.map(quote) : args, { stdio: 'inherit', shell: isWin, ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 失败（退出 ${r.status}）`);
};

const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : 'x64';
if (!['x64', 'arm64', 'ia32'].includes(arch)) fail('--arch 只能是 x64 / arm64 / ia32');

// 版本：引擎功能版本（和界面「引擎版本」一致）+ electron 版本取自 app 已安装的那一份
const engineVersion = /ENGINE_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(path.join(repo, 'engine/src/version.ts'), 'utf8'))?.[1];
if (!engineVersion) fail('读不到 ENGINE_VERSION（engine/src/version.ts）');
const electronPkg = path.join(app, 'node_modules/electron/package.json');
if (!existsSync(electronPkg)) fail('app/node_modules 不存在：先在 app 目录运行 npm ci');
const electronVersion = JSON.parse(readFileSync(electronPkg, 'utf8')).version;
let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).toString().trim();
  if (execFileSync('git', ['status', '--porcelain', '--', 'engine', 'app', 'windows'], { cwd: repo }).toString().trim()) commit += '（含未提交改动）';
} catch { /* 不在 git 里 */ }

console.log(`· 引擎 ${engineVersion} · Electron ${electronVersion} · win32-${arch} · 代码 ${commit}`);

// 1. 构建（vite 界面 + esbuild 主进程 / preload / 引擎包）
run(npm, ['run', 'build'], { cwd: app });

// 2. 暂存：运行只需要 dist、assets 和一个最小 package.json（没有运行时依赖，全部已打进 bundle）
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(path.join(app, 'dist'), path.join(stage, 'dist'), { recursive: true });
cpSync(path.join(app, 'assets'), path.join(stage, 'assets'), { recursive: true });
for (const f of ['dist/electron/main.cjs', 'dist/electron/preload.cjs', 'dist/engine/cli.mjs', 'dist/renderer/index.html', 'assets/icon.png', 'assets/tray.png']) {
  if (!existsSync(path.join(stage, f))) fail(`暂存缺少 ${f}`);
}
// 不带 sourcemap：体积小，也不把源码路径带给最终用户
for (const dir of ['dist/electron', 'dist/engine']) for (const f of readdirSync(path.join(stage, dir))) if (f.endsWith('.map')) rmSync(path.join(stage, dir, f));
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'cueclock', productName: 'CueClock', version: '0.1.0', description: 'CueClock 中控时间线（UDP / TCP 定时与触发）',
  main: 'dist/electron/main.cjs', private: true,
}, null, 2));
writeFileSync(path.join(stage, 'release.json'), JSON.stringify({ engineVersion, electronVersion, platform: 'win32', arch, commit, publisher: 'Fawen', builtAt: new Date().toISOString() }, null, 2));

// 3. 套上 Windows 版 Electron 运行时（首次会从 GitHub 下载约 100MB 的 Electron，之后走缓存）
// 图标与版本信息要用 rcedit（只能在 Windows 上跑）；交叉打包时不带这些参数
const native = isWin;
run(npx, ['--yes', '@electron/packager', stage, 'CueClock', '--platform=win32', `--arch=${arch}`, `--electron-version=${electronVersion}`,
  `--out=${path.join(out, 'pkg')}`, '--overwrite', '--asar=false', '--no-prune', '--app-copyright=Copyright (c) 2026 Fawen',
  ...(native ? [`--icon=${path.join(app, 'assets/icon.ico')}`, '--win32metadata.CompanyName=Fawen', '--win32metadata.ProductName=CueClock',
    '--win32metadata.FileDescription=CueClock 中控时间线', '--win32metadata.OriginalFilename=CueClock.exe'] : [])]);
const pkgDir = path.join(out, 'pkg', `CueClock-win32-${arch}`);
if (!existsSync(path.join(pkgDir, 'CueClock.exe'))) fail('没有生成 CueClock.exe');
if (!existsSync(path.join(pkgDir, 'resources/app/dist/electron/main.cjs'))) fail('resources/app 里没有主进程文件');

// 4. 数字签名（可选）：自签名证书，发布者显示为 Fawen
const canSign = isWin && process.env.CUECLOCK_SIGN_PFX_BASE64 && process.env.CUECLOCK_SIGN_PFX_PASSWORD;
if (canSign) {
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'sign.ps1'), '-File', path.join(pkgDir, 'CueClock.exe')]);
} else {
  console.log('· 未签名（' + (isWin ? '没有设置签名证书环境变量' : '只有在 Windows 上构建才能签名') + '）');
}

// 5. 使用说明、证书（公钥）和信任脚本放在 exe 旁边
for (const f of ['使用说明.txt', 'Fawen-CodeSigning.cer', 'trust-fawen-certificate.ps1']) cpSync(path.join(here, f), path.join(pkgDir, f));

// 6. zip（签名之后再压，否则 zip 里是未签名的 exe）
const zipName = `CueClock-${engineVersion}-win-${arch}.zip`;
const zipPath = path.join(out, zipName);
const folderName = path.basename(pkgDir);
let zipped = false;
for (const [cmd, args] of [['zip', ['-r', '-q', zipPath, folderName]], ['tar', ['-a', '-c', '-f', zipPath, folderName]], ['powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${folderName}' -DestinationPath '${zipPath}' -Force`]]]) {
  const r = spawnSync(cmd, args, { cwd: path.join(out, 'pkg'), stdio: 'ignore' });
  if (r.status === 0 && existsSync(zipPath)) { zipped = true; break; }
}
if (!zipped) fail('没有可用的压缩命令（zip / tar / powershell）；打包好的文件夹在 ' + pkgDir);
const mb = (n) => (n / 1048576).toFixed(1);
console.log(`✓ ${zipPath}  ${mb(statSync(zipPath).size)} MB`);
console.log(`  文件夹：${pkgDir}`);
