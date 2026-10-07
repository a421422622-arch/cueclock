import type { EngineStatus } from '../../../engine/src/engine.ts';

/**
 * 常驻的旧引擎可能尚未返回后来追加的字段。每次给引擎状态加新字段，都要在这里补默认值——
 * 否则新界面读到 undefined 就会渲染失败（曾经因此整页变黑）。
 */
export type EngineStatusMessage = Omit<EngineStatus, 'network' | 'devices' | 'pads' | 'sceneRuns' | 'inFlight'> & {
  network?: Omit<EngineStatus['network'], 'missing'> & { missing?: string[] };
  devices?: EngineStatus['devices'];
  pads?: EngineStatus['pads'];
  sceneRuns?: EngineStatus['sceneRuns'];
  inFlight?: EngineStatus['inFlight'];
};

export function normalizeEngineStatus(engine: EngineStatusMessage | null): EngineStatus | null {
  if (!engine) return null;
  return {
    ...engine,
    devices: engine.devices ?? [],
    pads: engine.pads ?? {},
    sceneRuns: engine.sceneRuns ?? [],
    inFlight: engine.inFlight ?? [],
    network: { ...engine.network, missing: engine.network?.missing ?? [] },
  };
}
