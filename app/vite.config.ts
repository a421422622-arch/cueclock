import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DaemonClient } from '../engine/src/client.ts';
import { defaultStateDir } from '../engine/src/paths.ts';

/**
 * 仅开发用：在浏览器里打开界面时，用这个中间件把 /__rpc 和 /__events 转给本机引擎，
 * 方便不开 Electron 也能调试界面。它不会进入生产构建（生产走 Electron 的 preload）。
 */
function devBridge(): Plugin {
  return {
    name: 'cueclock-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      const stateDir = process.env.CUECLOCK_HOME ?? defaultStateDir();
      const client = DaemonClient.forStateDir(stateDir, { autoReconnect: true });
      const streams = new Set<import('node:http').ServerResponse>();
      const push = (event: string, data: unknown) => {
        for (const res of streams) res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
      };
      client.on('log', (d) => push('log', d));
      client.on('status', (d) => push('status', d));
      client.on('project-changed', (d) => push('project-changed', d));
      client.on('connected', () => push('conn', true));
      client.on('disconnected', () => push('conn', false));
      client.connect().catch(() => void 0);

      server.middlewares.use('/__events', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ event: 'conn', data: client.connected })}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
      });
      server.middlewares.use('/__rpc', (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { method, params } = JSON.parse(body) as { method: string; params?: unknown };
            if (!client.connected) await client.connect();
            res.end(JSON.stringify({ ok: true, result: await client.request(method, params) }));
          } catch (e) {
            const err = e as { code?: string; message?: string; details?: unknown };
            res.end(JSON.stringify({ ok: false, error: { code: err.code ?? 'disconnected', message: err.message ?? '未连接到引擎', details: err.details } }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devBridge()],
  base: './',
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  resolve: { alias: { '@engine': path.resolve(import.meta.dirname, '../engine/src') } },
  server: { port: 5173, strictPort: true, fs: { allow: ['..'] } },
});
