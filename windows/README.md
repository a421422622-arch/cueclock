# CueClock — Windows 版

同一份代码（引擎、界面都是 TypeScript / Electron / React），没有单独分叉。这个目录放的是 **Windows 打包与说明**，以及 `.github/workflows/windows.yml`（在真实 Windows 机器上自动测试并打包）。

## 拿到安装包

两种来源，任选：

1. **GitHub Actions 产物**（在 Windows 机器上构建，推荐）：仓库 → Actions → `windows` → 最近一次成功的运行 → 页面底部 Artifacts → `CueClock-windows-x64`（zip，约 150 MB，保留 30 天）。仓库是私有的，需要登录有权限的账号下载。
2. **自己打包**（macOS / Linux / Windows 都行，需要 Node ≥ 22.18 和网络；**要带签名和 exe 文件信息只能在 Windows 上构建**，并设置环境变量 `CUECLOCK_SIGN_PFX_BASE64` / `CUECLOCK_SIGN_PFX_PASSWORD`）：
   ```bash
   cd app && npm ci            # 只需第一次
   node ../windows/build-windows.mjs
   ```
   产物：`windows/dist/CueClock-<引擎版本>-win-x64.zip`。第一次会下载约 100 MB 的 Windows 版 Electron（之后走缓存；网络慢时可能要等很久）。`--arch arm64` 可打 ARM 版。

## 安装与使用

解压到固定位置（如 `C:\CueClock\`），双击 `CueClock.exe`。详见 zip 里的 `使用说明.txt`：

- **代码签名：Fawen（自签名）**：`CueClock.exe` 用名为「Fawen」的自签名证书做了 Authenticode 数字签名（右键 exe → 属性 → 数字签名，发布者是 Fawen；文件被改动签名就会失效）。**自签名证书别的电脑默认不信任**，第一次运行 SmartScreen 仍可能提示：点「更多信息」→「仍要运行」。想让这台电脑信任它：以管理员身份运行 zip 里的 `trust-fawen-certificate.ps1`（把 `Fawen-CodeSigning.cer` 导入本机「受信任的根证书颁发机构」和「受信任的发布者」，只需一次）。要让**所有**电脑直接信任、并逐步消除 SmartScreen 提示，需要向证书机构购买代码签名证书（目前没买）。
  - 签名私钥只在 `~/CueClock-run/signing/`（本机，不进仓库）和仓库的加密 Secrets（`CUECLOCK_SIGN_PFX_BASE64` / `CUECLOCK_SIGN_PFX_PASSWORD`）里；公钥证书 `windows/Fawen-CodeSigning.cer` 在仓库里。只有在 Windows 上构建（GitHub Actions）才会签名；在 macOS 上交叉打包出来的 zip 是**未签名**的。
- **防火墙**：第一次运行选「专用网络」并允许；要接收 UDP 触发（监听端口）必须允许。
- **数据**：`%APPDATA%\CueClock\`（配置、自动备份、日志、操作记录）。换电脑 / 重装用「配置管理 → 导出备份包 / 从备份包恢复」。
- **关闭窗口** 只是收到系统托盘，引擎和日程继续跑；真正退出走托盘右键菜单。
- **开机自动启动**：界面「配置管理 → 软件设置」勾选「开机自动启动」（用 Windows 登录项实现）。

## 和 macOS 版的差别（已知限制）

| 功能 | macOS | Windows |
|---|---|---|
| 登录守护（崩溃后系统自动拉起界面） | ✅ LaunchAgent | ❌ 没有内置；可选用 `install-guard-task.ps1`（任务计划程序），**未在真实现场验证** |
| 「运行时防止电脑休眠」选项 | ✅ | ❌ 不支持；请在 Windows「电源和睡眠」里把睡眠设为「从不」 |
| `release.mjs`（一键切换正式版本、备份、核对） | ✅ | ❌ 只支持 macOS，Windows 上手动解压新版本覆盖 |
| 引擎崩溃后由界面拉起引擎 | ✅ | ✅ |
| 在线检测 Ping | ✅ | ✅（用 `ping -n 1 -w <毫秒>`，只认输出里的 TTL） |
| 其他功能（时间轴、面板、回读、操作记录、备份包…） | ✅ | ✅（同一份代码） |

### 可选：崩溃后自动重启（任务计划程序）

```powershell
# PowerShell，当前用户，不需要管理员
.\install-guard-task.ps1 -Exe "C:\CueClock\CueClock.exe"   # 安装：登录时启动；异常退出后每 1 分钟重试，最多 999 次
.\install-guard-task.ps1 -Remove                            # 卸载
```
正常退出（退出码 0）不会被拉起，与 macOS 版语义一致。和「开机自动启动」选一个即可。装好后请注销再登录、再手动结束进程各测一次。

## 在 Windows 上做过什么验证

见根目录 `交接文档.md` 第 35 节（含每一轮 GitHub Actions 的结果和链接）。要点：

- **真实 Windows 机器（GitHub Actions `windows-latest`）**：安装依赖、类型检查、引擎与界面单元测试、构建、打包、用打包出来的 `CueClock.exe --smoke-test` 启动引擎并连接。
- **没有做过**：在真实现场电脑 / 真实设备上的验收；Windows 上的 Electron 界面自检（`verify:isolated`，工作流里作为不阻断的实验步骤）；高 DPI 缩放；代码签名；安装程序（只有免安装 zip）；`install-guard-task.ps1` 的实机测试。

## 给开发者

- 打包脚本不依赖 wine。在 Windows 上构建时写入 exe 的图标（`app/assets/icon.ico`）和版本信息（公司 / 版权 = Fawen）并签名（`windows/sign.ps1`）；在 macOS / Linux 上交叉打包则跳过这两步。窗口 / 任务栏图标另外在运行时设置（`app/electron/main.ts`，`app.setAppUserModelId` + `BrowserWindow.icon`）。
- Windows 特有的代码：`engine/src/atomic.ts`（改名覆盖在目标被占用时退避重试，修自 CI 在真实 Windows 上发现的 `EPERM`）、`engine/src/health.ts`（ping 参数）、`engine/src/paths.ts`（`%APPDATA%\CueClock`）、`app/electron/autostart.ts`（登录项）。
- 本地开发（Windows）：`cd engine && npm ci && npm test`；`cd app && npm ci && node node_modules/electron/install.js && npm test && npm start`。
  （新版 npm 默认不执行依赖的安装脚本，`npm ci` 不会下载 Electron 运行时；如果 `npm start` 找不到 Electron，就运行上面那条 `node node_modules/electron/install.js`。）
