import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 守卫：渲染进程（浏览器环境，没有 Node、没有 Buffer）可达的所有源码，不能引用 Node 专属的东西。
 * 这类错误类型检查看不出来，只有运行时才会整页白屏——曾经因为界面间接引入 payload.ts（顶层用 Buffer）出过一次。
 */
const appSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const engineSrc = path.resolve(appSrc, '..', '..', 'engine', 'src');

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@engine/')) base = path.join(engineSrc, spec.slice(8));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null; // 第三方包
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c;
  return null;
}

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    // 只跟随值导入；`import type` 和 `export type` 编译后会被擦除
    for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/g)) {
      if (m[2]) continue;
      const r = resolveImport(f, m[3]!);
      if (r) queue.push(r);
    }
    for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
      const r = resolveImport(f, m[1]!);
      if (r) queue.push(r);
    }
  }
  return [...seen];
}

test('渲染进程可达的源码不依赖 Node（node: 模块、Buffer、process）', () => {
  const files = reachable(path.join(appSrc, 'main.tsx'));
  assert.ok(files.length > 20, `应遍历到足够多的文件，实际 ${files.length}`);
  assert.ok(files.some((f) => f.endsWith(path.join('engine', 'src', 'commands.ts'))), '应能跟到引擎的共享模块');
  const bad: string[] = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/from\s+['"]node:|require\(|\bBuffer\b|\bprocess\.(env|platform|cwd)/.test(code)) bad.push(path.relative(path.dirname(appSrc), f));
  }
  assert.deepEqual(bad, [], `这些文件会让渲染进程白屏（或间接被引入）：${bad.join('、')}`);
});
