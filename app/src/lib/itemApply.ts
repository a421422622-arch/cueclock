import type { Project } from '../../../engine/src/types.ts';

/**
 * 「保存并应用这一项」：只把草稿里的某一个对象（指令、设备、触发器、场景、面板、组、模式或单个事件点）
 * 合进引擎当前运行的配置，草稿里别的改动不动。这样编辑一条改一条，不用攒到最后统一应用。
 */
export type ItemRef =
  | { kind: 'command' | 'device' | 'trigger' | 'scene' | 'pad' | 'group' | 'timeline'; id: string }
  | { kind: 'cue'; timelineId: string; cueId: string };

const KEY = { command: 'commands', device: 'devices', trigger: 'triggers', scene: 'scenes', pad: 'pads', group: 'groups', timeline: 'timelines' } as const;
export const ITEM_LABEL: Record<ItemRef['kind'], string> = { command: '指令', device: '设备', trigger: '触发器', scene: '场景', pad: '面板', group: '组', timeline: '模式', cue: '事件点' };

type Named = { id: string; name: string };
const list = (p: Project, kind: keyof typeof KEY): Named[] => ((p as unknown as Record<string, Named[] | undefined>)[KEY[kind]] ?? []);

function find(p: Project, ref: ItemRef): Named | undefined {
  if (ref.kind === 'cue') return p.timelines.find((t) => t.id === ref.timelineId)?.cues.find((c) => c.id === ref.cueId);
  return list(p, ref.kind).find((x) => x.id === ref.id);
}

/** 把 item 放进 arr：已有就原位替换；没有就按它在草稿里的前一个邻居定位插入（找不到邻居放末尾）。 */
function upsert<T extends { id: string }>(arr: T[], item: T, draftOrder: T[]): T[] {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) return arr.map((x, j) => (j === i ? item : x));
  const at = draftOrder.findIndex((x) => x.id === item.id);
  for (let k = at - 1; k >= 0; k--) {
    const j = arr.findIndex((x) => x.id === draftOrder[k]!.id);
    if (j >= 0) return [...arr.slice(0, j + 1), item, ...arr.slice(j + 1)];
  }
  return at === 0 ? [item, ...arr] : [...arr, item];
}

export interface ItemMerge {
  /** 运行配置 + 这一项的草稿版本 */
  project: Project;
  name: string;
  /** 运行配置里原来没有这一项 */
  added: boolean;
}

/** 结果为 null：草稿里没有这一项；或事件点所属的模式还没应用（只能整体应用）。 */
export function mergeItem(base: Project, draft: Project, ref: ItemRef): ItemMerge | { error: string } | null {
  const item = find(draft, ref);
  if (!item) return null;
  const next = structuredClone(base);
  const copy = structuredClone(item);
  if (ref.kind === 'cue') {
    const tl = next.timelines.find((t) => t.id === ref.timelineId);
    if (!tl) return { error: '这个事件点所属的模式还没有应用到引擎，请先应用整个模式' };
    tl.cues = upsert(tl.cues, copy as (typeof tl.cues)[number], draft.timelines.find((t) => t.id === ref.timelineId)!.cues);
  } else {
    const key = KEY[ref.kind];
    (next as unknown as Record<string, Named[]>)[key] = upsert(list(next, ref.kind), copy, list(draft, ref.kind));
  }
  return { project: next, name: item.name, added: !find(base, ref) };
}

const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

/** 这一项在草稿里和运行配置里是否不同（新增也算不同）。草稿里没有就返回 false。 */
export function itemDiffers(base: Project | null | undefined, draft: Project | null | undefined, ref: ItemRef): boolean {
  if (!base || !draft) return false;
  const d = find(draft, ref);
  return !!d && canonical(d) !== canonical(find(base, ref));
}
