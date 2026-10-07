import { createAutoZoom } from './autoZoom.ts';

type Controller = ReturnType<typeof createAutoZoom>;
let controller: Controller | null | undefined;

/** 运行时的自动缩放控制器；只在 Electron 里有（浏览器调试模式没有页面缩放接口，返回 null）。 */
export function autoZoomController(): Controller | null {
  if (controller !== undefined) return controller;
  const bridge = window.cueclock;
  controller = bridge?.getZoomFactor && bridge.setZoomFactor
    ? createAutoZoom({ bridge: { getZoomFactor: () => bridge.getZoomFactor(), setZoomFactor: (f) => bridge.setZoomFactor(f) }, width: () => window.innerWidth, storage: window.localStorage })
    : null;
  return controller;
}
