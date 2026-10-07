import { useRef, useState } from 'react';
import type { Command } from '@engine/types.ts';
import { rpc } from '../store.ts';
import { RpcFailure } from '../transport.ts';
import { describeStatus, summarize } from '../lib/commandTest.ts';
import type { TestOutcome, Tone } from '../lib/commandTest.ts';

export interface TestState { busy: boolean; outcome: TestOutcome | null; error: string | null }

/** 「测试」按钮的状态：一次只跑一个；结果保留到下次测试。真实发包，用的是当前（含草稿）内容。 */
export function useCommandTest() {
  const [state, setState] = useState<TestState>({ busy: false, outcome: null, error: null });
  const running = useRef(false);
  const run = async (cmd: Command, args?: Record<string, string>): Promise<TestOutcome | null> => {
    if (running.current) return null;
    running.current = true;
    setState({ busy: true, outcome: null, error: null });
    try {
      const outcome = await rpc<TestOutcome>('runCommand', { command: cmd, args, wait: true });
      setState({ busy: false, outcome, error: null });
      return outcome;
    } catch (e) {
      setState({ busy: false, outcome: null, error: e instanceof RpcFailure ? e.message : String(e) });
      return null;
    } finally {
      running.current = false;
    }
  };
  return { ...state, run };
}

const TONE_CLASS: Record<Tone, string> = { ok: 'okc', warn: 'warnc', bad: 'err' };

/** 测试结果：一句话结论 + 每台设备一行。 */
export function TestResult({ state }: { state: TestState }) {
  if (state.busy) return <span className="hint">发送中，等待结果…</span>;
  if (state.error) return <span className="hint err">{state.error}</span>;
  const o = state.outcome;
  if (!o) return null;
  const s = summarize(o);
  return (
    <div className="testres">
      <div className={`hint ${TONE_CLASS[s.tone]}`}>{s.text}</div>
      {o.results.filter((r) => r.device !== '').map((r, i) => {
        const d = describeStatus(r.status);
        return <div key={i} className={`hint ${TONE_CLASS[d.tone]}`}>· {r.device}：{d.text}</div>;
      })}
      <div className="hint">发送的字节和回包内容见下方日志。</div>
    </div>
  );
}
