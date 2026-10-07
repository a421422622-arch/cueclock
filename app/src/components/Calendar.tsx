import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarData, Project } from '@engine/types.ts';
import { addDays, dateKey, dayKind, weekdayOf } from '@engine/calendar.ts';
import { resolveDay } from '@engine/rules.ts';
import { formatCalendarText, parseCalendarText } from '@engine/calendarText.ts';
import type { DayView } from '@engine/simulate.ts';
import { edit, rpc, select, setView, useStore } from '../store.ts';
import { groupColor } from '../lib/colors.ts';
import { layoutVars, useLayout } from '../lib/layoutStore.ts';
import { Splitter } from './Splitter.tsx';
import { DAY_KIND_LABEL } from '../lib/labels.ts';

const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

/** 月历网格：周一开头，补满整周，固定 6 行。 */
function monthCells(month: string): string[] {
  const first = `${month}-01`;
  const lead = (weekdayOf(first) + 6) % 7; // 周一=0
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function updateCalendar(p: Project, fn: (c: CalendarData) => void): void {
  const c: CalendarData = p.calendar ?? {};
  fn(c);
  p.calendar = c;
}

export function CalendarView() {
  const layout = useLayout();
  const project = useStore((s) => s.project)!;
  const [selDate, setSelDate] = useState(() => dateKey(new Date()));
  const [month, setMonth] = useState(() => selDate.slice(0, 7));
  const [dialog, setDialog] = useState(false);
  const todayKey = dateKey(new Date());

  const cells = useMemo(
    () =>
      monthCells(month).map((date) => {
        const res = resolveDay(project, date);
        const kind = dayKind(date, project.calendar);
        const chips: { key: string; name: string; color: string; gap?: boolean }[] = [];
        for (const g of project.groups) {
          const members = res.entries.filter((e) => e.timeline.groupId === g.id);
          if (members.length === 0) continue;
          const active = members.filter((e) => e.active);
          if (active.length === 0) chips.push({ key: `gap-${g.id}`, name: `${g.name}：无日程`, color: 'var(--warn)', gap: true });
          for (const e of active) chips.push({ key: e.timeline.id, name: e.timeline.name, color: groupColor(project, g.id) });
        }
        for (const e of res.entries.filter((x) => x.active && !project.groups.some((g) => g.id === x.timeline.groupId))) {
          chips.push({ key: e.timeline.id, name: e.timeline.name, color: groupColor(project, undefined) });
        }
        return { date, kind, holidayName: res.holidayName, chips };
      }),
    [project, month],
  );

  return (
    <div className="cal" style={layoutVars(layout)}>
      <div className="calmain">
        <div className="calhead">
          <button onClick={() => setMonth(shiftMonth(month, -1))}>◀</button>
          <h2>{month.replace('-', ' 年 ')} 月</h2>
          <button onClick={() => setMonth(shiftMonth(month, 1))}>▶</button>
          <button onClick={() => { setMonth(todayKey.slice(0, 7)); setSelDate(todayKey); }}>今天</button>
          <span className="grow" />
          <span className="tb dim">每格显示当天实际生效的时间线；黄色「无日程」表示该组当天没有任何时间线命中</span>
          <button onClick={() => setDialog(true)}>节假日日历…</button>
        </div>
        <div className="calgrid">
          {WEEK_HEAD.map((w) => <div key={w} className="wkh">周{w}</div>)}
          {cells.map((c) => (
            <div
              key={c.date}
              className={`cell k-${c.kind} ${c.date.slice(0, 7) !== month ? 'out' : ''} ${c.date === selDate ? 'sel' : ''} ${c.date === todayKey ? 'today' : ''}`}
              onClick={() => setSelDate(c.date)}
            >
              <div className="top1">
                <span className="dn">{Number(c.date.slice(8))}</span>
                {c.holidayName && <span className="hname">{c.holidayName}</span>}
                {c.kind === 'holiday' && <span className="kbadge holiday">休</span>}
                {c.kind === 'makeupWorkday' && <span className="kbadge makeupWorkday">班</span>}
              </div>
              {c.chips.slice(0, 4).map((ch) => (
                <div key={ch.key} className={`tchip ${ch.gap ? 'gap' : ''}`} style={{ borderColor: ch.color }} title={ch.name}>{ch.name}</div>
              ))}
              {c.chips.length > 4 && <div className="tchip more">+{c.chips.length - 4}</div>}
            </div>
          ))}
        </div>
      </div>
      <DayDetail date={selDate} />
      <Splitter k="calW" orientation="vertical" className="cal-split" label="日详情宽度" step={-1} measure={(e, r) => r.right - e.clientX} />
      {dialog && <CalendarTextDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

// ───────────── 某一天的详情 ─────────────

function DayDetail({ date }: { date: string }) {
  const project = useStore((s) => s.project)!;
  const conn = useStore((s) => s.conn);
  const [day, setDay] = useState<DayView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  // 用本地草稿向引擎要模拟结果：改了还没保存的规则也能立刻预览
  useEffect(() => {
    const my = ++seq.current;
    const t = setTimeout(() => {
      rpc<DayView[]>('simulate', { from: date, days: 1, project })
        .then((r) => my === seq.current && (setDay(r[0] ?? null), setErr(null)))
        .catch((e: Error) => my === seq.current && setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [date, project, conn]);

  const kind = dayKind(date, project.calendar);
  const holidayName = project.calendar?.holidays?.[date];
  const [name, setName] = useState('');
  useEffect(() => setName(''), [date]);

  const setHoliday = (n: string) =>
    edit((p) => updateCalendar(p, (c) => {
      c.holidays = { ...(c.holidays ?? {}), [date]: n || '节假日' };
      c.makeupWorkdays = (c.makeupWorkdays ?? []).filter((d) => d !== date);
    }));
  const setMakeup = () =>
    edit((p) => updateCalendar(p, (c) => {
      const h = { ...(c.holidays ?? {}) };
      delete h[date];
      c.holidays = h;
      c.makeupWorkdays = [...new Set([...(c.makeupWorkdays ?? []), date])].sort();
    }));
  const clearDay = () =>
    edit((p) => updateCalendar(p, (c) => {
      const h = { ...(c.holidays ?? {}) };
      delete h[date];
      c.holidays = h;
      c.makeupWorkdays = (c.makeupWorkdays ?? []).filter((d) => d !== date);
    }));

  const goto = (timelineId: string, cueId: string) => {
    select({ kind: 'cue', timelineId, cueId });
    setView('timeline');
  };

  return (
    <aside className="calside">
      <h3 style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>某日预览</h3>
      <div className="caldetail">
        <h3>{date} 星期{'日一二三四五六'[weekdayOf(date)]}</h3>
        <div className="sub">
          {DAY_KIND_LABEL[kind]}{holidayName ? `（${holidayName}）` : ''}
        </div>

        <div className="daybtns">
          {kind === 'holiday' ? (
            <>
              <input value={holidayName ?? ''} style={{ width: 120 }} onChange={(e) => setHoliday(e.target.value)} placeholder="节日名称" />
              <button onClick={clearDay}>恢复为普通日</button>
            </>
          ) : (
            <>
              <input value={name} style={{ width: 100 }} placeholder="节日名称" onChange={(e) => setName(e.target.value)} />
              <button onClick={() => setHoliday(name)}>设为放假日</button>
            </>
          )}
          {kind === 'makeupWorkday' ? (
            <button onClick={clearDay}>取消调休上班</button>
          ) : (
            <button onClick={setMakeup} title="周末但要上班的日子，会按工作日规则运行">设为调休上班日</button>
          )}
        </div>

        {err && <div className="note warn">{conn === 'connected' ? err : '与引擎断开，无法预览'}</div>}
        {day && (
          <>
            <div className="sech">时间线是否生效</div>
            {day.timelines.map((t) => (
              <div key={t.id} className="tlrow">
                <span className={`st ${t.active ? 'on' : 'off'}`}>{t.active ? '▶ 生效' : '· 跳过'}</span>
                <span><b>{t.name}</b><div className="why">{t.reason}</div></span>
              </div>
            ))}
            {day.timelines.length === 0 && <div className="empty">还没有时间线。</div>}
            <div className="sech" style={{ marginTop: 12 }}>当天会执行的内容 <span>{day.items.length} 个执行点</span></div>
            {day.items.length === 0 && <div className="empty">当天没有执行点。</div>}
            {day.items.map((it, i) => (
              <div key={i} className="dayitem" onClick={() => goto(it.timelineId, it.cueId)} title="点击在时间线中打开">
                <span className="tm">{it.time}</span>
                <span>
                  <b>{it.timelineName}/{it.cueName}</b>
                  <div className="desc">{it.description}</div>
                </span>
              </div>
            ))}
            {day.warnings.map((w, i) => <div key={i} className="note warn">{w}</div>)}
          </>
        )}
      </div>
    </aside>
  );
}

// ───────────── 节假日日历：文本导入/导出 ─────────────

const HELP = `一行一条，# 或 // 之后是注释：
  2026-10-01~2026-10-07 国庆节     放假日（可写区间，名称可省略）
  2026-10-05 国庆节                放假日（单日）
  班 2026-09-27                    调休上班日（也可写 调休 / work）`;

function CalendarTextDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)!;
  const [text, setText] = useState(() => formatCalendarText(project.calendar));
  const parsed = useMemo(() => parseCalendarText(text), [text]);
  const nHol = Object.keys(parsed.holidays).length;

  const apply = () => {
    edit((p) => updateCalendar(p, (c) => {
      c.holidays = parsed.holidays;
      c.makeupWorkdays = parsed.makeupWorkdays;
    }));
    onClose();
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>节假日日历</h3>
        <div className="mb">
          <pre>{HELP}</pre>
          <div className="note warn" style={{ margin: 0 }}>
            法定节假日和调休安排每年由国务院办公厅发布，软件不内置也不联网获取，请按官方通知填写。下面是当前日历，可直接编辑或粘贴整年数据，「应用」会整体替换。
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="例如：&#10;2026-10-01~2026-10-07 国庆节&#10;班 2026-09-27" />
          {parsed.errors.map((e) => (
            <div key={e.line} className="hint err">第 {e.line} 行：{e.message}　「{e.text}」</div>
          ))}
        </div>
        <div className="mf">
          <span className="dim" style={{ marginRight: 'auto', fontSize: 12 }}>
            {nHol} 个放假日 · {parsed.makeupWorkdays.length} 个调休上班日{parsed.errors.length ? ` · ${parsed.errors.length} 行有错误（该行被忽略）` : ''}
          </span>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={apply}>应用（替换整个日历）</button>
        </div>
      </div>
    </div>
  );
}
