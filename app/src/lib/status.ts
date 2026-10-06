import type { EngineStatus } from '../../../engine/src/engine.ts';

/** 常驻的旧引擎可能尚未返回后来追加的网卡缺失信息。 */
export type EngineStatusMessage = Omit<EngineStatus, 'network'> & {
  network?: Omit<EngineStatus['network'], 'missing'> & { missing?: string[] };
};

export function normalizeEngineStatus(engine: EngineStatusMessage | null): EngineStatus | null {
  if (!engine) return null;
  return { ...engine, network: { ...engine.network, missing: engine.network?.missing ?? [] } };
}
