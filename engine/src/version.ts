import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from './protocol.ts';

declare const __CUECLOCK_ENGINE_BUILD__: string;
export const ENGINE_VERSION = '0.3.0';
function sourceBuild(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const hash = createHash('sha256');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
    hash.update(file); hash.update(readFileSync(path.join(dir, file)));
  }
  return hash.digest('hex').slice(0, 16);
}
export const ENGINE_BUILD = typeof __CUECLOCK_ENGINE_BUILD__ === 'undefined' ? sourceBuild() : __CUECLOCK_ENGINE_BUILD__;
export interface EngineHello { protocol: number; engineVersion?: string; engineBuild?: string; capabilities?: string[] }
export const engineHello = (): EngineHello => ({ protocol: PROTOCOL_VERSION, engineVersion: ENGINE_VERSION, engineBuild: ENGINE_BUILD,
  capabilities: ['wall-clock-pending-actions', 'regex-trigger-parameters', 'network-missing', 'operation-status', 'device-override', 'device-feedback'] });
export interface EngineUpdate {
  runningVersion: string | null;
  runningBuild: string | null;
  expectedVersion: string;
  expectedBuild: string;
  protocol: number;
  expectedProtocol: number;
  needsRestart: boolean;
  compatible: boolean;
}
export function assessEngine(hello: EngineHello): EngineUpdate {
  return { runningVersion: hello.engineVersion ?? null, runningBuild: hello.engineBuild ?? null,
    expectedVersion: ENGINE_VERSION, expectedBuild: ENGINE_BUILD, protocol: hello.protocol, expectedProtocol: PROTOCOL_VERSION,
    compatible: hello.protocol === PROTOCOL_VERSION && hello.engineVersion === ENGINE_VERSION,
    needsRestart: hello.protocol !== PROTOCOL_VERSION || hello.engineVersion !== ENGINE_VERSION || hello.engineBuild !== ENGINE_BUILD };
}
