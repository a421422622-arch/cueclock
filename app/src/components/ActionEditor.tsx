import type { Action, CommandAction, Project, MatchKind, ReplyCheck, Terminator, UdpAction } from '@engine/types.ts';
import { paramValues, placeholdersOf, resolveActions, resolveCommandAction, substitute } from '@engine/commands.ts';
import { expandActions } from '@engine/expand.ts';
import { genId } from '../lib/labels.ts';
import { previewPayload, toHex } from '../lib/payload.ts';
import { getState, select, useStore } from '../store.ts';
import { Check, Field, NumInput, Seg } from './fields.tsx';

const KIND_OPTIONS: { value: MatchKind; label: string }[] = [
  { value: 'exact', label: '完全匹配' },
  { value: 'prefix', label: '前缀' },
  { value: 'contains', label: '包含' },
  { value: 'regex', label: '正则' },
];

const NO_ADDRS: string[] = [];
const TERM_LABEL: Record<Terminator, string> = { none: '无', cr: '\\r', lf: '\\n', crlf: '\\r\\n' };

/** 新增「使用指令」动作时默认选第一条指令：少一个"还没选"的无效中间状态（无效状态下引擎不接受保存）。 */
const firstCommandId = () => getState().project?.commands?.[0]?.id ?? '';

/** 一组动作的编辑器：事件点和触发器共用。 */
export function ActionList({ actions, onChange, defaultTarget, focusedAction, triggerTemplate = false, inScene = false }: { actions: Action[]; onChange: (next: Action[]) => void; defaultTarget?: string; focusedAction?: string; triggerTemplate?: boolean; inScene?: boolean }) {
  const hasCommands = useStore((s) => (s.project?.commands ?? []).length > 0);
  const hasScenes = useStore((s) => (s.project?.scenes ?? []).length > 0);
  const update = (i: number, next: Action) => onChange(actions.map((a, j) => (j === i ? next : a)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= actions.length) return;
    const next = [...actions];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const dup = (i: number) => {
    const next = [...actions];
    next.splice(i + 1, 0, { ...structuredClone(actions[i]!), id: genId('a') });
    onChange(next);
  };
  const remove = (i: number) => onChange(actions.filter((_, j) => j !== i));
  const typeName = (a: Action) => (a.type === 'udp' ? '自定义 UDP' : a.type === 'command' ? '使用指令' : a.type === 'scene' ? '使用场景' : a.type === 'delay' ? '延时' : '时间线控制');

  return (
    <div className="actions">
      {actions.length === 0 && <div className="empty">还没有动作。一个事件点可以有多个动作，用来同时控制多个目标。</div>}
      {actions.map((a, i) => (
        <div key={a.id} data-action-id={a.id} className={`act ${a.enabled === false ? 'off' : ''} ${focusedAction === a.id ? 'focused' : ''}`}>
          <div className="ah">
            <span className="no">#{i + 1}</span>
            <span className="ty">{typeName(a)}</span>
            <div className="x">
              <input type="checkbox" title="启用" checked={a.enabled !== false} onChange={(e) => update(i, { ...a, enabled: e.target.checked })} />
              <button className="ico" title="上移" onClick={() => move(i, -1)}>↑</button>
              <button className="ico" title="下移" onClick={() => move(i, 1)}>↓</button>
              <button className="ico" title="复制" onClick={() => dup(i)}>⧉</button>
              <button className="ico" title="删除" onClick={() => remove(i)}>✕</button>
            </div>
          </div>
          <div className="ab">
            {a.type === 'udp' && <SendEditor v={a} showOffset triggerTemplate={triggerTemplate} onChange={(patch) => update(i, { ...a, ...patch })} />}
            {a.type === 'command' && <CommandBody a={a} triggerTemplate={triggerTemplate} onChange={(n) => update(i, n)} />}
            {a.type === 'delay' && (
              <Field label="时长" hint="后面的动作整体顺延这么久">
                <NumInput value={a.ms} width={90} onChange={(v) => update(i, { ...a, ms: v ?? 0 })} /> ms
              </Field>
            )}
            {a.type === 'scene' && <SceneBody a={a} onChange={(n) => update(i, n)} />}
            {a.type === 'timeline' && <ControlBody a={a} onChange={(n) => update(i, n)} />}
          </div>
        </div>
      ))}
      <div className="addrow">
        <button
          className={hasCommands ? 'accent' : ''}
          title={hasCommands ? '从指令库里选一条，只需填参数' : '指令库是空的：先在左侧「指令」页签里添加'}
          disabled={!hasCommands}
          onClick={() => onChange([...actions, { id: genId('a'), type: 'command', commandId: firstCommandId(), ...(defaultTarget ? { targets: [defaultTarget] } : {}) }])}
        >
          ＋ 使用指令
        </button>
        <button onClick={() => onChange([...actions, { id: genId('a'), type: 'udp', targets: defaultTarget ? [defaultTarget] : [], format: 'ascii', payload: '' }])}>＋ 自定义 UDP</button>
        <button onClick={() => onChange([...actions, { id: genId('a'), type: 'delay', ms: 1000 }])}>＋ 延时</button>
        {!inScene && (
          <button
            className={hasScenes ? 'accent' : ''}
            title={hasScenes ? '整体使用一个场景（一组动作）' : '还没有场景：先在左侧「场景」页签里添加'}
            disabled={!hasScenes}
            onClick={() => onChange([...actions, { id: genId('a'), type: 'scene', sceneId: getState().project?.scenes?.[0]?.id ?? '' }])}
          >
            ＋ 使用场景
          </button>
        )}
        {!inScene && <button onClick={() => onChange([...actions, { id: genId('a'), type: 'timeline', op: 'disable', target: '' }])}>＋ 时间线控制</button>}
      </div>
    </div>
  );
}

// ───────────── 发送内容（自定义 UDP 与指令库共用） ─────────────

export interface SendValue {
  targets: string[];
  port?: number;
  sendFrom?: string;
  format: 'ascii' | 'hex';
  payload: string;
  terminator?: Terminator;
  offsetMs?: number;
  repeat?: number;
  repeatGapMs?: number;
  reply?: ReplyCheck | null;
  chase?: boolean;
}

/** 目标、端口、网卡、格式、内容、回包、重复、断电恢复。showOffset：事件点里的动作才有"偏移"。 */
export function SendEditor({
  v,
  onChange,
  showOffset,
  previewValues,
  triggerTemplate = false,
}: {
  v: SendValue;
  onChange: (patch: Partial<SendValue>) => void;
  showOffset?: boolean;
  /** 内容里有 {{参数}} 时，预览用这些值代入 */
  previewValues?: Record<string, string>;
  triggerTemplate?: boolean;
}) {
  const project = useStore((s) => s.project)!;
  // 注意：选择器必须返回稳定的引用。这里不能写 `?? []`——每次都是新数组，会让 React 误判状态一直在变，陷入无限渲染
  const localsRaw = useStore((s) => s.status?.network?.settings.localAddresses);
  const locals = localsRaw ?? NO_ADDRS;
  const tags = [...new Set(project.devices.map((d) => d.tag).filter((t): t is string => !!t))];
  const label = (t: string) => (t.startsWith('tag:') ? `标签 ${t.slice(4)}` : (project.devices.find((d) => d.id === t)?.name ?? `？${t}`));
  const known = (t: string) => (t.startsWith('tag:') ? tags.includes(t.slice(4)) : project.devices.some((d) => d.id === t));
  const targetDevices = project.devices.filter((d) => v.targets.includes(d.id) || (d.tag && v.targets.includes(`tag:${d.tag}`)));
  const noPort = v.port === undefined ? targetDevices.filter((d) => d.port === undefined) : [];
  const defaults = [...new Set(targetDevices.map((d) => d.port).filter((p): p is number => p !== undefined))];

  const shown = previewValues ? substitute(v.payload, previewValues) : v.payload;
  const dynamic = triggerTemplate && /\$(?:\$|\d)/.test(shown);
  const term = v.terminator ?? targetDevices[0]?.terminator ?? 'none';
  const pv = previewPayload(v.format, shown, term);
  const reply = v.reply;
  const setReply = (r: Partial<ReplyCheck>) => onChange({ reply: { ...(v.reply as ReplyCheck), ...r } });

  return (
    <>
      <Field label="目标">
        <div className="chips">
          {v.targets.map((t) => (
            <span key={t} className={`chip ${known(t) ? '' : 'bad'}`}>
              {label(t)}
              <i onClick={() => onChange({ targets: v.targets.filter((x) => x !== t) })}>×</i>
            </span>
          ))}
          <select
            className="chipadd"
            value=""
            onChange={(e) => e.target.value && !v.targets.includes(e.target.value) && onChange({ targets: [...v.targets, e.target.value] })}
          >
            <option value="">＋ 设备/标签</option>
            {tags.length > 0 && (
              <optgroup label="标签（同标签的全部设备）">
                {tags.map((t) => (
                  <option key={t} value={`tag:${t}`}>标签：{t}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="设备">
              {project.devices.map((d) => (
                <option key={d.id} value={d.id}>{d.name}  {d.ip}{d.port ? ':' + d.port : ''}</option>
              ))}
            </optgroup>
          </select>
        </div>
      </Field>
      <Field
        label="端口"
        hint={
          noPort.length > 0 ? (
            <span className="err">设备「{noPort.map((d) => d.name).join('、')}」没有默认端口，这里必须填</span>
          ) : v.port === undefined && defaults.length > 0 ? (
            `留空 = 用设备默认端口（${defaults.join('、')}）`
          ) : undefined
        }
      >
        <NumInput value={v.port} min={1} max={65535} width={84} allowEmpty onChange={(port) => onChange({ port })} />
      </Field>
      {locals.length > 0 && (
        <Field label="从网卡" hint="默认按目标所在子网自动选；只在需要强制从某块网卡发时才指定">
          <select value={v.sendFrom ?? ''} onChange={(e) => onChange({ sendFrom: e.target.value || undefined })}>
            <option value="">自动（按目标子网）</option>
            {locals.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
            {v.sendFrom && !locals.includes(v.sendFrom) && <option value={v.sendFrom}>{v.sendFrom}（未在设置里选中）</option>}
          </select>
        </Field>
      )}
      <Field label="格式">
        <Seg value={v.format} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} onChange={(format) => onChange({ format })} />
        {v.format === 'ascii' && (
          <select value={v.terminator ?? ''} onChange={(e) => onChange({ terminator: (e.target.value || undefined) as Terminator | undefined })}>
            <option value="">结束符：设备默认</option>
            {(Object.keys(TERM_LABEL) as Terminator[]).map((t) => (
              <option key={t} value={t}>结束符：{TERM_LABEL[t]}</option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="内容"
        hint={dynamic ? "触发时按捕获值生成字节，预览以实际收到的内容为准" : pv.ok ? <span className="okc">✓ {pv.bytes.length} 字节　{toHex(pv.bytes)}</span> : <span className="err">{pv.error}</span>}
      >
        <input className={`mono ${pv.ok || dynamic ? '' : 'bad'}`} value={v.payload} placeholder={v.format === 'hex' ? 'A5 01 FF' : 'SCENE 12   （支持 \\r \\n \\xFF）'} onChange={(e) => onChange({ payload: e.target.value })} />
      </Field>
      <Field label="时间">
        <span className="row">
          {showOffset && (
            <>偏移 <NumInput value={v.offsetMs ?? 0} onChange={(x) => onChange({ offsetMs: x ?? 0 })} width={58} />ms　</>
          )}
          {!reply && (
            <>
              重复 <NumInput value={v.repeat ?? 1} min={1} width={40} onChange={(x) => onChange({ repeat: x ?? 1 })} />次
              间隔 <NumInput value={v.repeatGapMs ?? 0} width={52} onChange={(x) => onChange({ repeatGapMs: x ?? 0 })} />ms
            </>
          )}
        </span>
      </Field>
      <Field label="回包" hint={reply ? '开启后只发一次，失败按「重试」次数重发；不再按「重复」发送' : '不校验：日志只记「已发送」'}>
        <Seg
          value={reply ? 'on' : 'off'}
          options={[{ value: 'off', label: '不校验' }, { value: 'on', label: '校验回包' }]}
          onChange={(x) => onChange({ reply: x === 'off' ? null : (v.reply ?? { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 500, retries: 1 }) })}
        />
      </Field>
      {reply && (
        <Field label="期望">
          <div className="replybox">
            <span className="row">
              <select value={reply.kind} onChange={(e) => setReply({ kind: e.target.value as MatchKind })}>
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
              {reply.kind !== 'regex' && (
                <Seg value={reply.format} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} onChange={(format) => setReply({ format })} />
              )}
            </span>
            <input className="mono" value={reply.pattern} placeholder={reply.kind === 'regex' ? '^OK (\\d+)$' : 'OK'} onChange={(e) => setReply({ pattern: e.target.value })} />
            <span className="row">
              超时 <NumInput value={reply.timeoutMs} min={1} width={58} onChange={(x) => setReply({ timeoutMs: x ?? 500 })} />ms　重试 <NumInput value={reply.retries} width={40} onChange={(x) => setReply({ retries: x ?? 0 })} />次
            </span>
          </div>
        </Field>
      )}
      <Field label="断电恢复" hint="已过去时可作为该目标的恢复状态；未到点动作按原计划继续执行">
        <Check checked={v.chase === true} onChange={(c) => onChange({ chase: c })} label="重启后补发" />
      </Field>
    </>
  );
}

// ───────────── 使用指令 ─────────────

function CommandBody({ a, onChange, triggerTemplate = false }: { a: CommandAction; onChange: (n: CommandAction) => void; triggerTemplate?: boolean }) {
  const project = useStore((s) => s.project)!;
  const commands = project.commands ?? [];
  const cmd = commands.find((c) => c.id === a.commandId);
  const tags = [...new Set(project.devices.map((d) => d.tag).filter((t): t is string => !!t))];
  const label = (t: string) => (t.startsWith('tag:') ? `标签 ${t.slice(4)}` : (project.devices.find((d) => d.id === t)?.name ?? `？${t}`));
  const overridden = !!(a.targets && a.targets.length > 0);

  if (!cmd) {
    return (
      <Field label="指令" hint={commands.length === 0 ? '指令库是空的：先在左侧「指令」页签里添加' : a.commandId ? <span className="err">找不到指令「{a.commandId}」</span> : undefined}>
        <select className={a.commandId ? 'bad' : ''} value={a.commandId} onChange={(e) => onChange({ ...a, commandId: e.target.value, args: {} })}>
          <option value="">选择指令…</option>
          {commands.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
    );
  }

  const { missing } = paramValues(cmd, a.args);
  const resolved = resolveCommandAction(cmd, a);
  const dynamic = triggerTemplate && Object.values(a.args ?? {}).some((v) => /\$(?:\$|\d)/.test(v));
  const pv = resolved.action ? previewPayload(resolved.action.format, resolved.action.payload, resolved.action.terminator ?? 'none') : null;
  const setArg = (name: string, value: string) => {
    const args = { ...(a.args ?? {}) };
    if (value === '') delete args[name];
    else args[name] = value;
    onChange({ ...a, args });
  };

  return (
    <>
      <Field label="指令" hint={cmd.note}>
        <span className="row">
          <select value={a.commandId} onChange={(e) => onChange({ ...a, commandId: e.target.value, args: {} })}>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button className="ico" title="在指令库里编辑这条指令" onClick={() => select({ kind: 'command', id: cmd.id })}>编辑 ↗</button>
        </span>
      </Field>
      {(cmd.params ?? []).map((p) => (
        <Field key={p.name} label={p.label || p.name} hint={p.default === undefined ? <span className={missing.includes(p.name) ? 'err' : ''}>必填</span> : `默认 ${p.default || '（空）'}`}>
          <input className={`mono ${missing.includes(p.name) ? 'bad' : ''}`} value={a.args?.[p.name] ?? ''} placeholder={p.default ?? ''} onChange={(e) => setArg(p.name, e.target.value)} />
        </Field>
      ))}
      <Field label="目标" hint={overridden ? undefined : '用指令里设置的目标；点＋可只在这里改成别的'}>
        <div className="chips">
          {(overridden ? a.targets! : cmd.targets).map((t) => (
            <span key={t} className={`chip ${overridden ? '' : 'dimchip'}`}>
              {label(t)}
              {overridden && <i onClick={() => { const next = a.targets!.filter((x) => x !== t); onChange({ ...a, targets: next.length ? next : undefined }); }}>×</i>}
            </span>
          ))}
          <select className="chipadd" value="" onChange={(e) => e.target.value && onChange({ ...a, targets: [...new Set([...(overridden ? a.targets! : []), e.target.value])] })}>
            <option value="">＋ 改目标</option>
            {tags.map((t) => (
              <option key={t} value={`tag:${t}`}>标签：{t}</option>
            ))}
            {project.devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          {overridden && <button className="ico" onClick={() => onChange({ ...a, targets: undefined })}>还原</button>}
        </div>
      </Field>
      <Field label="时间">
        <span className="row">
          偏移 <NumInput value={a.offsetMs ?? 0} onChange={(x) => onChange({ ...a, offsetMs: x ?? 0 })} width={58} />ms　端口 <NumInput value={a.port} min={1} max={65535} width={72} allowEmpty onChange={(x) => onChange({ ...a, port: x })} />
          <span className="hint">{a.port === undefined && cmd.port ? `（指令：${cmd.port}）` : ''}</span>
        </span>
      </Field>
      <Field
        label="将发送"
        hint={
          resolved.error ? <span className="err">{resolved.error}</span> : dynamic ? '触发时按捕获值生成字节' : pv?.ok ? <span className="okc">✓ {pv.bytes.length} 字节　{toHex(pv.bytes)}</span> : <span className="err">{pv?.error}</span>
        }
      >
        <code className="mono sendprev">{resolved.action ? `${resolved.action.payload}` : '（参数不全）'}</code>
      </Field>
    </>
  );
}

/** 场景预览里的一行说明（界面自己写，不能引用引擎的 describe.ts：它依赖 Node 的 Buffer，渲染进程里没有）。 */
function sendSummary(project: Project, a: Action, i: number, n: number): string {
  if (a.type !== 'udp') return a.type === 'delay' ? `延时 ${a.ms}ms` : a.type;
  const names = a.targets.map((t) => (t.startsWith('tag:') ? `标签 ${t.slice(4)}` : (project.devices.find((d) => d.id === t)?.name ?? `？${t}`))).join('、');
  return `${names}${a.port ? ':' + a.port : ''}  ${a.format === 'hex' ? 'HEX ' : ''}${a.payload || '（空）'}${n > 1 ? `  [${i + 1}/${n}]` : ''}${a.reply ? '  · 校验回包' : ''}`;
}

/** 使用场景：选一个场景，可整体后移；下方列出展开后会发送什么，改场景会同步变化。 */
function SceneBody({ a, onChange }: { a: Extract<Action, { type: 'scene' }>; onChange: (n: Action) => void }) {
  const project = useStore((s) => s.project)!;
  const scenes = project.scenes ?? [];
  const scene = scenes.find((s) => s.id === a.sceneId);
  const resolved = scene ? resolveActions(project, [a]) : null;
  const items = resolved ? expandActions(resolved.actions) : [];

  if (!scene) {
    return (
      <Field label="场景" hint={scenes.length === 0 ? '还没有场景：先在左侧「场景」页签里添加' : a.sceneId ? <span className="err">找不到场景「{a.sceneId}」</span> : undefined}>
        <select className={a.sceneId ? 'bad' : ''} value={a.sceneId} onChange={(e) => onChange({ ...a, sceneId: e.target.value })}>
          <option value="">选择场景…</option>
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <>
      <Field label="场景" hint={scene.note}>
        <span className="row">
          <select value={a.sceneId} onChange={(e) => onChange({ ...a, sceneId: e.target.value })}>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button className="ico" title="在场景库里编辑这个场景" onClick={() => select({ kind: 'scene', id: scene.id })}>编辑 ↗</button>
        </span>
      </Field>
      <Field label="整体偏移" hint="整个场景相对事件点后移；场景内部的延时只在场景内部生效，不会顺延后面的动作">
        <span className="row"><NumInput value={a.offsetMs ?? 0} onChange={(x) => onChange({ ...a, offsetMs: x ?? 0 })} width={64} />ms</span>
      </Field>
      <Field label="将发送" hint={resolved && resolved.errors.length > 0 ? <span className="err">{resolved.errors.join('；')}</span> : `${items.length} 个执行点`}>
        <div className="sceneprev">
          {items.length === 0 && <span className="dim">（场景是空的）</span>}
          {items.map((x, i) => (
            <div key={i}><span className="tm">+{x.relMs}ms</span> {sendSummary(project, x.action, x.repIndex, x.repTotal)}</div>
          ))}
        </div>
      </Field>
    </>
  );
}

function ControlBody({ a, onChange }: { a: Extract<Action, { type: 'timeline' }>; onChange: (n: Action) => void }) {
  const project = useStore((s) => s.project)!;
  return (
    <>
      <Field label="操作">
        <Seg value={a.op} options={[{ value: 'disable', label: '临时禁用' }, { value: 'enable', label: '恢复启用' }]} onChange={(op) => onChange({ ...a, op })} />
      </Field>
      {a.op === 'disable' && (
        <Field label="持续" hint={a.until === 'midnight' ? '到今天午夜自动恢复，明天照常运行' : '一直有效，直到被「恢复启用」或引擎重启'}>
          <Seg value={a.until ?? 'restart'} options={[{ value: 'restart', label: '直到恢复/重启' }, { value: 'midnight', label: '仅今天' }]} onChange={(until) => onChange({ ...a, until })} />
        </Field>
      )}
      <Field label="对象">
        <select className={a.target ? '' : 'bad'} value={a.target} onChange={(e) => onChange({ ...a, target: e.target.value })}>
          <option value="">选择…</option>
          <optgroup label="整组">
            {project.groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </optgroup>
          <optgroup label="时间线">
            {project.timelines.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </optgroup>
        </select>
      </Field>
    </>
  );
}

export { placeholdersOf };
export type { UdpAction };
