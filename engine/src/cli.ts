#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from './types.ts';
import { validateProject } from './validate.ts';
import { dateKey } from './calendar.ts';
import { formatClock } from './time.ts';
import { simulateDays } from './simulate.ts';
import { Engine } from './engine.ts';
import type { LogEntry } from './engine.ts';
import { attachFileLogger } from './logfile.ts';
import { Daemon } from './daemon.ts';
import { DaemonClient } from './client.ts';
import { ProjectStore } from './store.ts';
import { defaultStateDir } from './paths.ts';
import { resetLock } from './lock.ts';

const USAGE = `用法：
  node src/cli.ts init <项目.json>                       新建空项目
  node src/cli.ts reset-lock [--state-dir 目录]          忘记编辑锁密码时清除它（先停引擎）
  node src/cli.ts check <项目.json>                      静态检查
  node src/cli.ts simulate <项目.json> [--from YYYY-MM-DD] [--days N]
  node src/cli.ts run <项目.json> [--log-dir 目录] [--dry]   直接运行（无后台进程，调试用）
  node src/cli.ts daemon [项目.json] [--port N] [--state-dir 目录] [--dry]   启动引擎守护进程（不写项目则用上次打开的）
  node src/cli.ts ctl <方法|watch> [JSON参数] [--state-dir 目录]   连接守护进程（调试）`;

async function load(file: string): Promise<Project> {
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  const issues = validateProject(project);
  for (const i of issues) console.log(`${i.level === 'error' ? '✗ 错误' : '! 警告'} [${i.path}] ${i.message}`);
  if (issues.some((i) => i.level === 'error')) process.exit(1);
  return project;
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printLog(e: LogEntry): void {
  const lag = e.lagMs === undefined ? '' : ` [+${e.lagMs}ms]`;
  const body = e.ascii !== undefined ? `${e.ascii}  (${e.hex})` : '';
  console.log(
    `${formatClock(e.t)} ${e.dir.padEnd(3)} ${(e.remote ?? '').padEnd(21)} ${e.result.padEnd(9)} ${body}${lag}` +
      `${e.source ? ' ‹' + e.source + '›' : ''}${e.detail ? ' ' + e.detail : ''}`,
  );
}

async function main(): Promise<void> {
  const [cmd, file0, ...rest0] = process.argv.slice(2);
  // daemon 的项目文件可以省略：此时第一个参数其实是选项
  const noFile = (cmd === 'daemon' || cmd === 'reset-lock') && (!file0 || file0.startsWith('--'));
  const file: string = noFile ? '' : (file0 ?? '');
  const rest = noFile && file0 ? [file0, ...rest0] : rest0;
  if (!cmd || (!file && cmd !== 'daemon' && cmd !== 'reset-lock')) {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  if (cmd === 'reset-lock') {
    // 忘记编辑锁密码时用。先停掉引擎（否则它会在下次保存设置时把锁写回去），再运行。
    const dir = opt(rest, '--state-dir') ?? defaultStateDir();
    console.log((await resetLock(dir)) ? `已清除编辑锁（${dir}）。请重新启动引擎。` : `没有找到编辑锁（${dir}），无需处理。`);
    return;
  }

  if (cmd === 'init') {
    const target = path.resolve(file);
    if (existsSync(target)) {
      console.error(`${target} 已存在，不覆盖`);
      process.exit(1);
    }
    await new ProjectStore(target).save({ name: '新项目', devices: [], groups: [], timelines: [], triggers: [] });
    console.log(`已创建 ${target}`);
    return;
  }

  if (cmd === 'daemon') {
    const daemon = new Daemon({
      projectFile: file ? path.resolve(file) : undefined,
      stateDir: opt(rest, '--state-dir'),
      port: opt(rest, '--port') === undefined ? undefined : Number(opt(rest, '--port')),
      dryRun: rest.includes('--dry'),
      initialPaused: opt(rest, '--initial-paused') === undefined ? undefined : opt(rest, '--initial-paused') === 'true',
      onShutdown: () => void daemon.stop().finally(() => process.exit(0)),
    });
    const info = await daemon.start();
    console.log(`引擎守护进程已启动 pid=${info.pid} 端口=${info.port} 项目=${info.projectFile}`);
    console.log(`连接信息：${daemon.infoFile}　Ctrl-C 退出`);
    const quit = async () => {
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    return;
  }

  if (cmd === 'ctl') {
    // 这里 file 是方法名
    const client = DaemonClient.forStateDir(opt(rest, '--state-dir') ?? defaultStateDir());
    await client.connect();
    if (file === 'watch') {
      client.on('log', (e: LogEntry) => printLog(e));
      client.on('disconnected', () => process.exit(0));
      console.log('已连接，监听日志中，Ctrl-C 退出');
      return;
    }
    const raw = rest.find((a) => !a.startsWith('--') && a !== opt(rest, '--state-dir'));
    const result = await client.request(file, raw ? JSON.parse(raw) : undefined);
    console.log(JSON.stringify(result, null, 2));
    client.close();
    return;
  }

  const project = await load(path.resolve(file));

  if (cmd === 'check') {
    console.log('项目检查通过');
    return;
  }

  if (cmd === 'simulate') {
    const from = opt(rest, '--from') ?? dateKey(new Date());
    const days = Number(opt(rest, '--days') ?? 1);
    for (const day of simulateDays(project, from, days)) {
      console.log(`\n═══ ${day.date} 星期${day.weekday} · ${day.kindLabel}${day.holidayName ? '（' + day.holidayName + '）' : ''}`);
      for (const t of day.timelines) console.log(`  ${t.active ? '▶ 生效' : '· 跳过'}  ${t.name}  — ${t.reason}`);
      for (const w of day.warnings) console.log(`  ! ${w}`);
      if (day.items.length === 0) console.log('  （当天没有执行点）');
      for (const it of day.items) console.log(`  ${it.time}  ${it.timelineName}/${it.cueName}  ${it.description}`);
    }
    return;
  }

  if (cmd === 'run') {
    const engine = new Engine(project, { dryRun: rest.includes('--dry') });
    engine.on('log', printLog);
    const logDir = opt(rest, '--log-dir');
    if (logDir) attachFileLogger(engine, path.resolve(logDir));
    await engine.start();
    console.log(`监听端口：${engine.listenerPorts().join(', ') || '无'}　Ctrl-C 退出`);
    const quit = async () => {
      await engine.stop();
      process.exit(0);
    };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    return;
  }

  console.log(USAGE);
  process.exit(1);
}

// 常驻的引擎进程：任何一处漏网的异常都不应该让日程停掉。记录下来，继续运行。
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r instanceof Error ? (r.stack ?? r.message) : r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.stack ?? e.message));

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
