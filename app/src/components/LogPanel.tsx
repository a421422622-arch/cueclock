import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { logId } from '../lib/logBuffer.ts';
import { formatClock } from '@engine/time.ts';
import type { LogEntry } from '@engine/engine.ts';
import { displayedProject, beginDraft, markAlertsSeen, rpc, select, showLogTab, showPadTile, toast, toggleLog, useStore } from '../store.ts';
import { ALERT_LABEL, mergeAlerts, unseenCount } from '../lib/alerts.ts';
import { RESULT_LABEL, RESULT_TONE } from '../lib/labels.ts';
import { appBridge, RpcFailure } from '../transport.ts';
import { Seg } from './fields.tsx';
import { Icon } from './Icon.tsx';

type Filter = 'all' | 'tx' | 'rx' | 'bad';

export function LogPanel() {
  const tab = useStore((s) => s.logTab);
  const logs = useStore((s) => s.logs);
  const history = useStore((s) => s.alertHistory);
  const seenAt = useStore((s) => s.alertsSeenAt);
  const unseen = useMemo(() => unseenCount(mergeAlerts(history, logs), seenAt), [history, logs, seenAt]);
  const issues = useStore((s) => s.issues);
  const errors = issues.filter((i) => i.level === 'error').length;
  const collapsed = useStore((s) => s.logCollapsed);
  const [testOpen, setTestOpen] = useState(false); // 测试发送条不常用，默认收起，把空间给日志
  return (
    <section className="log">
      <div className="loghead">
        <div className="tabs2">
          <span className={tab === 'log' ? 'on' : ''} onClick={() => showLogTab('log')}>日志</span>
          <span className={tab === 'alerts' ? 'on' : ''} onClick={() => showLogTab('alerts')}>
            告警{unseen.count > 0 && <b className={unseen.hasError ? 'bad' : 'warn'}> {unseen.count}</b>}
          </span>
          <span className={tab === 'audit' ? 'on' : ''} onClick={() => showLogTab('audit')}>操作记录</span>
          <span className={tab === 'issues' ? 'on' : ''} onClick={() => showLogTab('issues')}>
            问题{issues.length > 0 && <b className={errors ? 'bad' : 'warn'}> {issues.length}</b>}
          </span>
        </div>
        <span className="grow" />
        <button className={`ico ${testOpen ? 'on' : ''}`} aria-pressed={testOpen} title="向任意 IP:端口发一条测试内容" onClick={() => setTestOpen(!testOpen)}>测试发送</button>
        <button className="ico" onClick={toggleLog} aria-expanded={!collapsed}>{collapsed ? '展开日志' : '收起日志'}</button>
      </div>
      {tab === 'log' ? <Logs /> : tab === 'alerts' ? <Alerts /> : tab === 'audit' ? <Audit /> : <Issues />}
      {testOpen && <TestSend />}
    </section>
  );
}

interface LogDays { dir: string; keepDays: number; days: { date: string; bytes: number }[] }
interface LogDay { date: string; entries: LogEntry[]; total: number; truncated: boolean }
const LIVE = '';
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * 日志页签：默认看本次连接收到的实时日志；也可以选一天，看引擎按天保存在本地的完整日志
 * （logs/YYYY-MM-DD.jsonl，保留天数在「配置管理 → 软件设置」里改）。
 */
function Logs() {
  const live = useStore((s) => s.logs);
  const [day, setDay] = useState(LIVE);
  const [days, setDays] = useState<LogDays | null>(null);
  const [loaded, setLoaded] = useState<LogDay | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'ascii' | 'hex'>('ascii');
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const loadDays = () => void rpc<LogDays>('listLogDays').then((r) => { setDays(r); setLoadErr(null); }).catch((e) => setLoadErr(e instanceof RpcFailure ? e.message : String(e)));
  useEffect(loadDays, []);
  useEffect(() => {
    if (day === LIVE) { setLoaded(null); return; }
    let stop = false;
    setLoaded(null);
    void rpc<LogDay>('readLogDay', { date: day }).then((r) => { if (!stop) { setLoaded(r); setLoadErr(null); } }).catch((e) => { if (!stop) setLoadErr(e instanceof RpcFailure ? e.message : String(e)); });
    return () => { stop = true; };
  }, [day]);

  const source = day === LIVE ? live : loaded?.entries ?? [];
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((l) => {
      if (filter === 'tx' && l.dir !== 'TX') return false;
      if (filter === 'rx' && l.dir !== 'RX') return false;
      if (filter === 'bad' && !['bad', 'warn'].includes(RESULT_TONE[l.result] ?? '')) return false;
      return !q || `${l.remote ?? ''} ${l.ascii ?? ''} ${l.hex ?? ''} ${l.source ?? ''} ${l.detail ?? ''}`.toLowerCase().includes(q);
    });
  }, [source, filter, query]);
  // 实时日志只渲染最后 400 条（列表不卡）；历史日志一天可能上万条，渲染最后 2000 条，导出导出全部匹配的
  const cap = day === LIVE ? 400 : 2000;
  const shown = useMemo(() => matched.slice(-cap), [matched, cap]);

  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const exportLogs = () => {
    const text = matched.map((l) => `${new Date(l.t).toLocaleDateString('sv-SE')} ${formatClock(l.t)}\t${l.dir}\t${l.remote ?? ''}\t${RESULT_LABEL[l.result] ?? l.result}\t${l.ascii ?? ''}\t${l.hex ?? ''}\t${l.source ?? ''}\t${l.detail ?? ''}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' }));
    a.download = `cueclock-log-${day || 'live'}-${Date.now()}.tsv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const reveal = () => void appBridge?.appAction('revealLogs').catch((e) => toast(`打不开文件夹：${(e as Error).message}`));

  return (
    <>
      <div className="logtools">
        <select className="logday" value={day} aria-label="查看哪一天的日志" onFocus={loadDays} onChange={(e) => { stick.current = true; setDay(e.target.value); }}>
          <option value={LIVE}>实时（本次运行）</option>
          {days?.days.map((d) => <option key={d.date} value={d.date}>{d.date} · {kb(d.bytes)}</option>)}
        </select>
        <Seg<Filter> value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部' }, { value: 'tx', label: '发送 TX' }, { value: 'rx', label: '接收 RX' }, { value: 'bad', label: '异常' }]} />
        <input className="logsearch" value={query} placeholder="搜索 IP、内容、说明…" onChange={(e) => setQuery(e.target.value)} />
        <span className="grow" />
        <Seg value={view} onChange={setView} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} />
        <button onClick={exportLogs} title="导出当前筛选出的全部日志（TSV，可用表格软件打开）">导出</button>
        {appBridge && <button className="ico" aria-label="打开日志文件夹" onClick={reveal} title={days ? `打开日志文件夹：${days.dir}` : '打开日志文件夹'}><Icon name="folder" size={15} /></button>}
      </div>
      <div className="logbody" ref={body} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {loadErr && <div className="empty">读取本地日志失败：{loadErr}{/未知|unknown/i.test(loadErr) ? '（旧版引擎没有历史日志功能，需要重启引擎）' : ''}</div>}
        {day !== LIVE && !loaded && !loadErr && <div className="empty">读取 {day} 的日志…</div>}
        {!loadErr && (day === LIVE || loaded) && shown.length === 0 && <div className="empty">{source.length ? '没有符合筛选的日志。' : day === LIVE ? '暂无日志。' : '这一天没有日志。'}</div>}
        {shown.map((l) => <LogRow key={logId(l)} l={l} view={view} />)}
      </div>
      <div className="logfoot">
        {day === LIVE ? `实时 · 显示最近 ${shown.length} 条` : `${day} · 共 ${loaded?.total ?? 0} 条${loaded?.truncated ? `（太多，只读入最后 ${loaded.entries.length} 条，完整内容在日志文件夹）` : ''}${matched.length > cap ? ` · 符合筛选 ${matched.length} 条，列表显示最后 ${cap} 条，导出包含全部` : ''}`}
        {days && <span className="dim"> · 本地保存{days.keepDays === 0 ? '，永久保留' : `最近 ${days.keepDays} 天`}（在「配置管理 → 软件设置」里修改）</span>}
      </div>
    </>
  );
}

const LogRow = memo(function LogRow({ l, view }: { l: LogEntry; view: 'ascii' | 'hex' }) {
  const tone = RESULT_TONE[l.result] ?? 'dim';
  const content = l.ascii === undefined ? '' : view === 'hex' ? l.hex : l.ascii;
  const [open, setOpen] = useState(false); // 点一下展开整行（内容与说明很长时默认被截断）
  return (
    // 系统消息没有地址和内容：让说明占满这两列，不留大片空白
    <div className={`ln ${open ? 'open' : ''} ${!l.remote && !content ? 'bare' : ''}`} onClick={() => { if (!window.getSelection()?.toString()) setOpen(!open); }}>
      <span className="ts">{formatClock(l.t)}</span>
      <span className={l.dir === 'TX' ? 'tx' : l.dir === 'RX' ? 'rx' : 'sys'}>{l.dir}</span>
      <span className={`res ${l.alert ? (l.alert.level === 'error' ? 'bad' : l.alert.level === 'warn' ? 'warn' : tone) : tone}`}>{l.alert ? '⚠ ' : ''}{RESULT_LABEL[l.result] ?? l.result}</span>
      {(l.remote || content) && <>
        <span className="ip">{l.remote ?? ''}</span>
        <span className="c" title={`${l.ascii ?? ''}\n${l.hex ?? ''}`}>{content}</span>
      </>}
      <span className="det" title={`${l.source ?? ""} ${l.detail ?? ""}`.trim()}>
        {l.source && <b>{l.source}</b>} {l.detail}
        {l.lagMs !== undefined && <i className="lag"> +{l.lagMs}ms</i>}
      </span>
    </div>
  );
});

interface AuditRow { t: number; action: string; detail: string; changes?: string[] }

/** 操作记录：谁在什么时候改了什么配置（应用配置、恢复备份、网络设置、编辑锁……）。单独存盘，比普通日志留得久。 */
function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => rpc<AuditRow[]>('getAudit', { limit: 300 }).then((r) => { if (!stop) { setRows(r.slice().reverse()); setErr(null); } }).catch((e) => { if (!stop) setErr(e instanceof RpcFailure ? e.message : String(e)); });
    void load();
    const t = setInterval(load, 4000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return (
    <div className="logbody audit">
      {err && <div className="empty">读取失败：{err}（旧版引擎没有操作记录功能，需要重启引擎）</div>}
      {!err && rows === null && <div className="empty">读取中…</div>}
      {!err && rows?.length === 0 && <div className="empty">还没有操作记录。应用配置、恢复备份、修改网络设置等都会记在这里。</div>}
      {rows?.map((r) => <details key={`${r.t}-${r.action}-${r.detail}`} className="auditrow">
        <summary><span className="ts">{new Date(r.t).toLocaleString('zh-CN', { hour12: false })}</span><b>{r.action}</b><span className="det" title={r.detail}>{r.detail}</span>{r.changes?.length ? <span className="tag">{r.changes.length} 项变更</span> : null}</summary>
        {r.changes?.length ? <ul>{r.changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
      </details>)}
    </div>
  );
}

type AlertFilter = 'all' | 'attention' | 'error';

/** 告警页签：磁盘上最近 7 天的历史 + 本次运行实时收到的。只记录，不对外发送。 */
function Alerts() {
  const history = useStore((s) => s.alertHistory);
  const logs = useStore((s) => s.logs);
  const seenAt = useStore((s) => s.alertsSeenAt);
  const [filter, setFilter] = useState<AlertFilter>('attention');
  // 进入页签时记下"上次查看时间"用来高亮新告警，然后立刻标为已读（徽标清零）
  const [viewedBefore] = useState(seenAt);
  useEffect(() => {
    markAlertsSeen();
  }, []);

  const all = useMemo(() => mergeAlerts(history, logs), [history, logs]);
  const shown = useMemo(
    () => all.filter((a) => (filter === 'all' ? true : filter === 'error' ? a.alert!.level === 'error' : a.alert!.level !== 'info')).reverse().slice(0, 300),
    [all, filter],
  );
  const dayOf = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

  return (
    <>
      <div className="logtools">
        <Seg<AlertFilter> value={filter} onChange={setFilter} options={[{ value: 'attention', label: '需留意' }, { value: 'error', label: '仅错误' }, { value: 'all', label: '全部（含恢复）' }]} />
        <span className="grow" />
        <span className="dim" style={{ fontSize: 11 }}>最近 7 天 · 共 {all.length} 条 · 仅记录在日志里，不对外发送</span>
      </div>
      <div className="logbody">
        {shown.length === 0 && <div className="empty">{filter === 'all' ? '最近 7 天没有告警。' : '没有需要留意的告警。'}</div>}
        {shown.map((a, i) => (
          <div key={`${a.t}-${i}`} className={`alrow ${a.alert!.level} ${a.t > viewedBefore ? 'fresh' : ''}`}>
            <span className="ts">{dayOf(a.t)} {formatClock(a.t)}</span>
            <span className={`lv ${a.alert!.level}`}>{a.alert!.level === 'error' ? '错误' : a.alert!.level === 'warn' ? '警告' : '恢复'}</span>
            <span className="code">{ALERT_LABEL[a.alert!.code] ?? a.alert!.code}</span>
            <span className="subj">{a.alert!.subject ?? ''}</span>
            <span className="det" title={a.detail}>{a.detail}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Issues() {
  const issues = useStore((s) => s.issues);
  const goto = (path: string) => {
    if (!beginDraft()) return;
    const [kind, a, b] = path.split('/');
    if (kind === 'devices' && a) select({ kind: 'device', id: a });
    else if (kind === 'triggers' && a) select({ kind: 'trigger', id: a });
    else if (kind === 'groups' && a) select({ kind: 'group', id: a });
    else if (kind === 'commands' && a) select({ kind: 'command', id: a });
    else if (kind === 'scenes' && a) select({ kind: 'scene', id: a });
    else if (kind === 'pads' && a) showPadTile(a, b);
    else if (kind === 'timelines' && a) select(b ? { kind: 'cue', timelineId: a, cueId: b } : { kind: 'timeline', id: a });
  };
  return (
    <div className="logbody">
      {issues.length === 0 && <div className="empty">没有问题。</div>}
      {issues.map((i, k) => (
        <div key={k} className={`issue ${i.level}`} onClick={() => goto(i.path)}>
          <span>{i.level === 'error' ? '✗ 错误' : '! 警告'}</span>
          <span className="mono dim">{i.path}</span>
          <span>{i.message}</span>
        </div>
      ))}
      {issues.some((i) => i.level === 'error') && <div className="empty">有错误时无法应用到引擎；修好后请检查并应用。</div>}
    </div>
  );
}

function TestSend() {
  const locked = useStore((s) => s.lock.enabled && !s.lock.unlocked);
  const project = useStore(displayedProject)!;
  const [dev, setDev] = useState<string>('');
  const [ip, setIp] = useState('127.0.0.1');
  const [port, setPort] = useState('5000');
  const [format, setFormat] = useState<'ascii' | 'hex'>('ascii');
  const [term, setTerm] = useState<'none' | 'cr' | 'lf' | 'crlf'>('none');
  const [payload, setPayload] = useState('');
  const [src, setSrc] = useState<'follow' | 'random' | 'fixed'>('follow');
  const [srcPort, setSrcPort] = useState('50000');
  const [res, setRes] = useState<{ text: string; tone: string } | null>(null);
  const device = project.devices.find((d) => d.id === dev);

  const send = async () => {
    const target = device ? { ip: device.ip, port: device.port ?? Number(port) } : { ip, port: Number(port) };
    setRes({ text: '发送中…', tone: 'dim' });
    try {
      const sourcePort = src === 'random' ? 'random' : src === 'fixed' ? Number(srcPort) : undefined;
      const r = await rpc<{ result: string }>('testSend', { ...target, format, payload, terminator: term, ...(sourcePort !== undefined ? { sourcePort } : {}) });
      setRes({ text: RESULT_LABEL[r.result] ?? r.result, tone: RESULT_TONE[r.result] ?? 'dim' });
    } catch (e) {
      setRes({ text: e instanceof RpcFailure ? e.message : String(e), tone: 'bad' });
      toast('测试发送失败');
    }
  };

  return (
    <div className="testsend" inert={locked}>
      <span className="dim">测试发送</span>
      <select value={dev} onChange={(e) => { setDev(e.target.value); const d = project.devices.find((x) => x.id === e.target.value); if (d) { setFormat(d.format ?? 'ascii'); setTerm(d.terminator ?? 'none'); } }}>
        <option value="">自定义 IP…</option>
        {project.devices.map((d) => <option key={d.id} value={d.id}>{d.name} {d.ip}{d.port ? ':' + d.port : ''}</option>)}
      </select>
      {!device && <input className="mono" style={{ width: 112 }} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IP" />}
      {(!device || device.port === undefined) && <input className="mono" style={{ width: 58 }} value={port} onChange={(e) => setPort(e.target.value)} placeholder="端口" />}
      <Seg value={format} onChange={setFormat} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} />
      {format === 'ascii' && (
        <select value={term} onChange={(e) => setTerm(e.target.value as typeof term)}>
          <option value="none">无结束符</option><option value="cr">\r</option><option value="lf">\n</option><option value="crlf">\r\n</option>
        </select>
      )}
      <select value={src} title="从哪个本机端口发出：跟随软件设置 / 每次随机 / 指定端口" onChange={(e) => setSrc(e.target.value as typeof src)}>
        <option value="follow">源端口：默认</option><option value="random">源端口：随机</option><option value="fixed">源端口：指定</option>
      </select>
      {src === 'fixed' && <input className="mono" style={{ width: 58 }} value={srcPort} onChange={(e) => setSrcPort(e.target.value)} placeholder="源端口" />}
      <input className="mono grow" value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={format === 'hex' ? 'A5 01 FF' : 'SCENE 3'} onKeyDown={(e) => e.key === 'Enter' && payload && void send()} />
      <button className="primary" disabled={!payload} onClick={send}>发送</button>
      {res && <span className={`res ${res.tone}`}>{res.text}</span>}
    </div>
  );
}
