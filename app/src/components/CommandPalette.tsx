import { useEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '@engine/types.ts';
import { beginDraft, displayedProject, openConfiguration, prepareApply, resumeSchedule, rpc, select, setPadId, setView, showLogTab, toast, useStore, viewRuntime } from '../store.ts';
import { appBridge, RpcFailure } from '../transport.ts';
import { filterPalette, paletteItems } from '../lib/palette.ts';
import type { PaletteItem } from '../lib/palette.ts';
import { describeStatus, requiredParams, summarize } from '../lib/commandTest.ts';
import type { TestOutcome } from '../lib/commandTest.ts';
import { openSettingsSearch } from './SettingsDialog.tsx';
import { Icon } from './Icon.tsx';

async function testCommand(c: Command): Promise<void> {
  select({ kind: 'command', id: c.id });
  if (requiredParams(c).length > 0) { toast(`「${c.name}」有必填参数，请在右侧填写后点「测试发送」`); return; }
  try {
    const o = await rpc<TestOutcome>('runCommand', { command: c, wait: true });
    toast(`测试「${c.name}」：${summarize(o).text}${o.results.length === 1 ? `（${describeStatus(o.results[0]!.status).text}）` : ''}`);
  } catch (e) {
    toast(`测试「${c.name}」失败：${e instanceof RpcFailure ? e.message : String(e)}`);
  }
}

/** ⌘K / Ctrl+K：搜索并跳到设备、指令、事件点、页面、设置，或直接执行常用操作。 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const project = useStore(displayedProject)!;
  const paused = useStore((s) => s.status?.engine?.paused === true);
  const dirty = useStore((s) => s.saveState === 'dirty');
  const editing = useStore((s) => s.configurationView === 'draft');
  const locked = useStore((s) => s.lock.enabled && !s.lock.unlocked);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const all = useMemo(() => paletteItems(project, { paused, dirty, editing }), [project, paused, dirty, editing]);
  const shown = useMemo(() => filterPalette(all, q), [all, q]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const run = (x: PaletteItem) => {
    onClose();
    const t = x.target;
    switch (t.kind) {
      case 'view': setView(t.view); return;
      case 'select': select(t.sel); if (t.sel.kind === 'timeline') setView('timeline'); return;
      case 'cue': select({ kind: 'cue', timelineId: t.timelineId, cueId: t.cueId }); setView('timeline'); return;
      case 'pad': setPadId(t.id); setView('pad'); return;
      case 'log': showLogTab(t.tab); return;
      case 'setting': openSettingsSearch(t.query); return;
      case 'test': {
        if (locked) { toast('编辑已锁定：测试发送需要先解锁'); return; }
        const c = (project.commands ?? []).find((x) => x.id === t.commandId);
        if (c) void testCommand(c);
        return;
      }
      case 'action':
        if (t.action === 'pause') void rpc('pause').catch((e) => toast(`操作失败：${(e as Error).message}`));
        else if (t.action === 'resume') void resumeSchedule().catch((e) => toast(`操作失败：${(e as Error).message}`));
        else if (t.action === 'apply') void prepareApply();
        else if (t.action === 'draft') beginDraft();
        else if (t.action === 'runtime') void viewRuntime();
        else if (t.action === 'files') openConfiguration('files');
        else void appBridge?.appAction(t.action).catch((e) => toast((e as Error).message));
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const x = shown[active]; if (x) run(x); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return <div className="modal-bg palette-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal palette" role="dialog" aria-modal="true" aria-label="快速跳转">
      <div className="palette-input">
        <Icon name="search" size={16} />
        <input autoFocus value={q} placeholder="搜索设备、指令、事件点、设置，或输入「暂停」「测试 开灯」…" aria-label="快速跳转" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={shown[active] ? `pal-${active}` : undefined} />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-list" id="palette-list" role="listbox" ref={list}>
        {shown.length === 0 && <div className="empty">没有找到「{q}」</div>}
        {shown.map((x, i) => (
          <div key={x.key} id={`pal-${i}`} role="option" aria-selected={i === active} className={`palette-item ${i === active ? 'on' : ''}`} onMouseMove={() => setActive(i)} onClick={() => run(x)}>
            <span className="g">{x.group}</span><span className="l">{x.label}</span>{x.sub && <span className="s">{x.sub}</span>}
          </div>
        ))}
      </div>
      <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+K 随时打开</span></div>
    </div>
  </div>;
}
