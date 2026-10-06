import type { Action, Project } from '../../../engine/src/types.ts';

/** 项目里所有会执行的动作列表：时间线事件点、触发器、以及场景内部。引用计数、删除提示都用它。 */
export function allActions(project: Project): Action[] {
  return [
    ...project.timelines.flatMap((t) => t.cues.flatMap((c) => c.actions)),
    ...project.triggers.flatMap((t) => t.actions),
    ...(project.scenes ?? []).flatMap((s) => s.actions),
  ];
}

export const sceneRefCount = (project: Project, sceneId: string): number =>
  allActions(project).filter((a) => a.type === 'scene' && a.sceneId === sceneId).length;
