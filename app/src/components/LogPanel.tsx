import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '@engine/time.ts';
import type { LogEntry } from '@engine/engine.ts';
import { rpc, select, toast, toggleLog, useStore } from '../store.ts';
import { RESULT_LABEL, RESULT_TONE } from '../lib/labels.ts';
import { RpcFailure } from '../transport.ts';
import { Seg } from './fields.tsx';

type Filter = 'all' | 'tx' | 'rx' | 'bad';

export function LogPanel() {
  const [tab, setTab] = useState<'log' | 'issues'>('log');
  const issues = useStore((s) => s.issues);
  const errors = issues.filter((i) => i.level === 'error').length;
  const collapsed = useStore((s) => s.logCollapsed);
  return (
    <section className="log">
      <div className="loghead">
        <div className="tabs2">
          <span className={tab === 'log' ? 'on' : ''} onClick={() => { setTab('log'); if (collapsed) toggleLog(); }}>日志</span>
          <span className={tab === 'issues' ? 'on' : ''} onClick={() => { setTab('issues'); if (collapsed) toggleLog(); }}>
            问题{issues.length > 0 && <b className={errors ? 'bad' : 'warn'}> {issues.length}</b>}
          </span>
        </div>
        <span className="grow" />
        <button className="ico" onClick={toggleLog} aria-expanded={!collapsed}>{collapsed ? '展开日志' : '收起日志'}</button>
      </div>
      {tab === 'log' ? <Logs /> : <Issues />}
      <TestSend />
    </section>
  );
}

function Logs() {
  const logs = useStore((s) => s.logs);
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'ascii' | 'hex'>('ascii');
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const f = logs.filter((l) => {
      if (filter === 'tx') return l.dir === 'TX';
      if (filter === 'rx') return l.dir === 'RX';
      if (filter === 'bad') return ['bad', 'warn'].includes(RESULT_TONE[l.result] ?? '');
      return true;
    });
    return f.slice(-400);
  }, [logs, filter]);

  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const exportLogs = () => {
    const text = logs.map((l) => `${formatClock(l.t)}\t${l.dir}\t${l.remote ?? ''}\t${RESULT_LABEL[l.result] ?? l.result}\t${l.ascii ?? ''}\t${l.hex ?? ''}\t${l.source ?? ''}\t${l.detail ?? ''}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' }));
    a.download = `cueclock-log-${Date.now()}.tsv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="logtools">
        <Seg<Filter> value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部' }, { value: 'tx', label: '发送 TX' }, { value: 'rx', label: '接收 RX' }, { value: 'bad', label: '异常' }]} />
        <span className="grow" />
        <Seg value={view} onChange={setView} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'HEX' }]} tone={{ ascii: 'a', hex: 'h' }} />
        <button onClick={exportLogs}>导出</button>
      </div>
      <div className="logbody" ref={body} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {shown.length === 0 && <div className="empty">暂无日志。</div>}
        {shown.map((l, i) => <LogRow key={`${l.t}-${i}`} l={l} view={view} />)}
      </div>
    </>
  );
}

function LogRow({ l, view }: { l: LogEntry; view: 'ascii' | 'hex' }) {
  const tone = RESULT_TONE[l.result] ?? 'dim';
  const content = l.ascii === undefined ? '' : view === 'hex' ? l.hex : l.ascii;
  return (
    <div className="ln">
      <span className="ts">{formatClock(l.t)}</span>
      <span className={l.dir === 'TX' ? 'tx' : l.dir === 'RX' ? 'rx' : 'sys'}>{l.dir}</span>
      <span className="ip">{l.remote ?? ''}</span>
      <span className="c" title={`${l.ascii ?? ''}\n${l.hex ?? ''}`}>{content}</span>
      <span className={`res ${tone}`}>{RESULT_LABEL[l.result] ?? l.result}</span>
      <span className="det" title={l.detail}>
        {l.source && <b>{l.source}</b>} {l.detail}
        {l.lagMs !== undefined && <i className="lag"> +{l.lagMs}ms</i>}
      </span>
    </div>
  );
}

function Issues() {
  const issues = useStore((s) => s.issues);
  const goto = (path: string) => {
    const [kind, a, b] = path.split('/');
    if (kind === 'devices' && a) select({ kind: 'device', id: a });
    else if (kind === 'triggers' && a) select({ kind: 'trigger', id: a });
    else if (kind === 'groups' && a) select({ kind: 'group', id: a });
    else if (kind === 'commands' && a) select({ kind: 'command', id: a });
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
      {issues.some((i) => i.level === 'error') && <div className="empty">有错误时修改不会保存到引擎；修好后会自动保存。</div>}
    </div>
  );
}

function TestSend() {
  const project = useStore((s) => s.project)!;
  const [dev, setDev] = useState<string>('');
  const [ip, setIp] = useState('127.0.0.1');
  const [port, setPort] = useState('5000');
  const [format, setFormat] = useState<'ascii' | 'hex'>('ascii');
  const [term, setTerm] = useState<'none' | 'cr' | 'lf' | 'crlf'>('none');
  const [payload, setPayload] = useState('');
  const [res, setRes] = useState<{ text: string; tone: string } | null>(null);
  const device = project.devices.find((d) => d.id === dev);

  const send = async () => {
    const target = device ? { ip: device.ip, port: device.port ?? Number(port) } : { ip, port: Number(port) };
    setRes({ text: '发送中…', tone: 'dim' });
    try {
      const r = await rpc<{ result: string }>('testSend', { ...target, format, payload, terminator: term });
      setRes({ text: RESULT_LABEL[r.result] ?? r.result, tone: RESULT_TONE[r.result] ?? 'dim' });
    } catch (e) {
      setRes({ text: e instanceof RpcFailure ? e.message : String(e), tone: 'bad' });
      toast('测试发送失败');
    }
  };

  return (
    <div className="testsend">
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
      <input className="mono grow" value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={format === 'hex' ? 'A5 01 FF' : 'SCENE 3'} onKeyDown={(e) => e.key === 'Enter' && payload && void send()} />
      <button className="primary" disabled={!payload} onClick={send}>发送</button>
      {res && <span className={`res ${res.tone}`}>{res.text}</span>}
    </div>
  );
}
