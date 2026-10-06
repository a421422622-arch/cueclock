// 用 esbuild 打包：引擎（作为独立进程运行的 JS）、Electron 主进程、preload。
// 引擎源码是 TypeScript（直接靠 Node 的类型剥离运行），打进 Electron 时统一打成 JS，
// 这样不依赖 Electron 内置 Node 的版本特性。
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2]; // 'engine' 只打引擎
const engineSrc = path.join(root, '../engine/src');
const fingerprint = createHash('sha256');
for (const file of readdirSync(engineSrc).filter((f) => f.endsWith('.ts')).sort()) {
  fingerprint.update(file); fingerprint.update(readFileSync(path.join(engineSrc, file)));
}
const engineBuild = fingerprint.digest('hex').slice(0, 16);

const jobs = {
  engine: {
    entryPoints: [path.join(root, '../engine/src/cli.ts')],
    outfile: path.join(root, 'dist/engine/cli.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
  },
  main: {
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(root, 'dist/electron/main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  preload: {
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(root, 'dist/electron/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
};

for (const [name, cfg] of Object.entries(jobs)) {
  if (only && only !== name) continue;
  await build({ bundle: true, logLevel: 'warning', sourcemap: true,
    define: { __CUECLOCK_ENGINE_BUILD__: JSON.stringify(engineBuild),
      ...(cfg.format === 'cjs' ? { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(engineSrc, 'version.ts')).href) } : {}) }, ...cfg });
  console.log(`built ${name} → ${path.relative(root, cfg.outfile)}`);
}
