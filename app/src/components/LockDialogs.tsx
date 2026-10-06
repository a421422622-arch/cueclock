import { useEffect, useState } from 'react';
import { closeBackups, closeUnlock, rpc, toast, unlock, useStore } from '../store.ts';
import { RpcFailure } from '../transport.ts';
import { summaryText } from '../lib/lockUi.ts';
import type { BackupSummary } from '../lib/lockUi.ts';

/** 解锁：输入编辑锁密码。查看和急停不需要它。 */
export function UnlockDialog() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(await unlock(pw));
    setBusy(false);
    setPw('');
  };
  return (
    <div className="modal-bg" onClick={closeUnlock}>
      <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <h3>🔒 编辑已锁定</h3>
        <div className="mb">
          <div className="hint">输入密码后才能修改配置、测试发送、切换配置、停止引擎。查看和急停不受影响。</div>
          <input type="password" autoFocus value={pw} placeholder="编辑锁密码" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && void submit()} />
          {err && <div className="hint err">{err}</div>}
        </div>
        <div className="mf">
          <button onClick={closeUnlock}>取消</button>
          <button className="primary" disabled={!pw || busy} onClick={submit}>解锁</button>
        </div>
      </div>
    </div>
  );
}

interface Backup { name: string; t: number; size: number; projectName: string; summary: BackupSummary }

/** 从自动备份恢复配置。恢复前会先备份当前版本，所以恢复本身也能撤回。 */
export function BackupDialog() {
  const currentName = useStore((s) => s.project?.name);
  const [list, setList] = useState<Backup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => rpc<Backup[]>('listBackups').then(setList).catch((e: Error) => setErr(e.message));
  useEffect(() => void load(), []);

  const restore = async (b: Backup) => {
    const when = new Date(b.t).toLocaleString();
    if (!window.confirm(`恢复到「${b.projectName}」（${when}）？\n\n当前配置会先自动备份一份，之后随时可以再恢复回来。恢复期间约几百毫秒内不执行事件。`)) return;
    setBusy(b.name);
    setErr(null);
    try {
      await rpc('restoreBackup', { name: b.name });
      toast('已从备份恢复');
      closeBackups();
    } catch (e) {
      setErr(e instanceof RpcFailure ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="modal-bg" onClick={closeBackups}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>从备份恢复 <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>（当前：{currentName}）</span></h3>
        <div className="mb">
          <div className="hint">每次保存配置前，软件会自动备份旧版本（至少间隔 1 分钟，保留最近 30 份）。下面每一项是「被覆盖之前的样子」。</div>
          {err && <div className="note warn" style={{ margin: 0 }}>{err}</div>}
          {list === null && !err && <div className="empty">读取中…</div>}
          {list?.length === 0 && <div className="empty">还没有备份。修改并保存配置后就会产生。</div>}
          {list?.map((b, i) => (
            <div key={b.name} className="bkrow">
              <div>
                <b>{new Date(b.t).toLocaleString()}</b>{i === 0 && <span className="tag" style={{ marginLeft: 6 }}>最近</span>}
                <div className="dim" style={{ fontSize: 11.5 }}>{b.projectName} · {summaryText(b.summary)}</div>
              </div>
              <button disabled={busy !== null} onClick={() => void restore(b)}>{busy === b.name ? '恢复中…' : '恢复到此版本'}</button>
            </div>
          ))}
        </div>
        <div className="mf"><button onClick={closeBackups}>关闭</button></div>
      </div>
    </div>
  );
}
