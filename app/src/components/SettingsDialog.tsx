import { useEffect, useState } from 'react';
import type { NetworkSettings, NicInfo } from '@engine/network.ts';
import { closeSettings, lockNow, openBackups, openUnlock, removeLockPassword, rpc, setLockPassword, toast, useStore } from '../store.ts';
import { checkNewPassword } from '../lib/lockUi.ts';
import { appBridge } from '../transport.ts';
import type { AppState } from '../transport.ts';
import { RpcFailure } from '../transport.ts';
import { Check, Field, NumInput } from './fields.tsx';
import { RestartEngineButton } from './EngineVersion.tsx';

interface NetInfo {
  settings: NetworkSettings;
  source: 'machine' | 'project' | 'default';
  missing: string[];
  available: boolean;
  interfaces: NicInfo[];
}

export function SettingsDialog() {
  return (
    <div className="modal-bg" onClick={closeSettings}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>设置 <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>（这些是这台电脑的设置，不会写进项目文件）</span></h3>
        <div className="mb">
          <div className="sech">引擎版本与运行</div>
          <EngineVersionSection />
          <NetworkSection />
          <StartupSection />
          <LockSection />
          <BackupSection />
        </div>
        <div className="mf"><button onClick={closeSettings}>关闭</button></div>
      </div>
    </div>
  );
}

function EngineVersionSection() {
  const update = useStore((s) => s.engineUpdate);
  return <div className="row">
    <span className="hint">运行：{update?.runningVersion ?? '未知'} · 界面需要：{update?.expectedVersion ?? '读取中'}</span>
    <RestartEngineButton />
  </div>;
}

// ───────────── 本机网络 ─────────────

function NetworkSection() {
  const status = useStore((s) => s.status);
  const [info, setInfo] = useState<NetInfo | null>(null);
  /** 勾选的网卡，按勾选顺序；第一块是"没有匹配子网时"的默认出口 */
  const [addrs, setAddrs] = useState<string[]>([]);
  const [port, setPort] = useState<number | undefined>(undefined);
  const [listenAll, setListenAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = () =>
    rpc<NetInfo>('getNetwork')
      .then((n) => {
        setInfo(n);
        setAddrs(n.settings.localAddresses ?? []);
        setPort(n.settings.localPort);
        setListenAll(n.settings.listenAll === true);
        setLoadErr(null);
      })
      .catch((e: Error) => setLoadErr(e.message));
  useEffect(() => void load(), []);

  if (loadErr) return <div className="note warn">无法读取网络设置：{loadErr}</div>;
  if (!info) return <div className="empty">读取中…</div>;

  const saved = info.settings.localAddresses ?? [];
  const dirty = addrs.join() !== saved.join() || port !== info.settings.localPort || listenAll !== (info.settings.listenAll === true);
  const present = new Set(info.interfaces.map((n) => n.address));
  const absent = addrs.filter((a) => !present.has(a)); // 勾选了、但本机现在没有的
  const engine = status?.engine ?? null;
  const toggle = (a: string, on: boolean) => setAddrs((cur) => (on ? [...cur, a] : cur.filter((x) => x !== a)));

  const apply = async () => {
    if (!window.confirm('应用后引擎会重启（约几百毫秒内不执行任何事件）。继续？')) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await rpc<{ running: boolean; startError: string | null; missing: string[] }>('setNetwork', {
        network: { localAddresses: addrs, localPort: port, listenAll: listenAll || undefined },
      });
      setMsg(
        !r.running
          ? { text: r.startError ?? '引擎未能启动', bad: true }
          : r.missing.length > 0
            ? { text: `已应用，引擎运行中；网卡 ${r.missing.join('、')} 暂不可用，后台重试中`, bad: true }
            : { text: '已应用，引擎运行中', bad: false },
      );
      await load();
    } catch (e) {
      setMsg({ text: e instanceof RpcFailure ? e.message : String(e), bad: true });
      toast('应用失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sech">本机网络</div>
      {info.source === 'project' && <div className="note warn">当前沿用的是项目文件里的旧网络设置。点「应用」后会改为这台电脑的设置。</div>}
      {!engine && status?.daemon.startError && <div className="note warn">{status.daemon.startError}</div>}
      <div className="form wide">
        <Field label="发送网卡" hint="可多选：对外的 UDP 要发往多个不同子网时，把对应网卡都勾上。发给某个目标时，自动用它所在子网的那块网卡；一个都不勾 = 由系统按路由决定">
          <div className="niclist">
            {info.interfaces.map((n) => {
              const on = addrs.includes(n.address);
              return (
                <label key={n.address} className={`nic-row ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={(e) => toggle(n.address, e.target.checked)} />
                  <span className="mono">{n.address}</span>
                  <span className="dim">{n.name} · /{n.cidr}{n.internal ? ' · 回环，仅本机测试' : ''}</span>
                  {on && addrs[0] === n.address && addrs.length > 1 && <span className="tag">默认</span>}
                </label>
              );
            })}
            {absent.map((a) => (
              <label key={a} className="nic-row on gone">
                <input type="checkbox" checked onChange={() => toggle(a, false)} />
                <span className="mono">{a}</span>
                <span className="err">本机当前没有这个地址</span>
              </label>
            ))}
            {info.interfaces.length === 0 && <div className="empty">没有找到网卡</div>}
          </div>
          {absent.length > 0 && <div className="hint err">网线没插好、网卡未启用，或地址被改了。引擎会先用其余网卡运行，并每隔几秒重试，恢复后自动加入。</div>}
          {addrs.length > 1 && <div className="hint">「默认」（第一个勾选的）用于目标不在任何已选子网时；受限广播 255.255.255.255 会从每块网卡各发一次。</div>}
          <button style={{ marginTop: 2 }} onClick={() => void load()}>刷新网卡列表</button>
        </Field>
        <Field label="本地源端口" hint="高级。留空 = 每次启动由系统随机分配。固定后，设备回包都回到这个端口，便于防火墙放行。目标端口请在每条指令里设置">
          <NumInput value={port} min={1} max={65535} width={90} allowEmpty onChange={setPort} />
        </Field>
        <Field label="触发器监听" hint="接收触发的 UDP 端口绑定在哪里">
          <Check checked={listenAll} onChange={setListenAll} label="监听所有网卡" />
          <div className="hint">{listenAll ? '⚠ 所有网卡都能收到触发包（含办公网/外网口），请确保触发器有来源白名单' : addrs.length ? `只监听已勾选的网卡：${addrs.join('、')}` : '没勾选网卡时监听所有网卡'}</div>
        </Field>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <button className="primary" disabled={!dirty || busy} onClick={apply}>{busy ? '应用中…' : '应用并重启引擎'}</button>
        {engine && (
          <span className="hint okc">
            当前：引擎运行中 · 发送网卡 {engine.network.localAddresses?.join('、') || '自动'}
            {engine.network.missing.length > 0 && <span className="err">（缺 {engine.network.missing.join('、')}）</span>}
          </span>
        )}
        {msg && <span className={`hint ${msg.bad ? 'err' : 'okc'}`}>{msg.text}</span>}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>提示：网卡 IP 若由 DHCP 分配，重启或换线后可能变化，现场建议给控制网卡设置固定 IP。发往所有已勾选子网之外的目标时，实际出口由系统路由表决定。</div>
    </>
  );
}

// ───────────── 启动与后台（仅桌面应用） ─────────────

function StartupSection() {
  const [st, setSt] = useState<AppState | null>(null);
  useEffect(() => {
    if (!appBridge) return;
    const load = () => void appBridge!.appState().then(setSt).catch(() => {});
    load();
    return appBridge.onAppState(load);
  }, []);

  return (
    <>
      <div className="sech" style={{ marginTop: 16 }}>启动与后台</div>
      {!appBridge || !st ? (
        <div className="hint pad">这些选项只在桌面应用里可用。</div>
      ) : (
        <div className="form wide">
          <Field
            label="开机自启"
            hint={
              !st.canLaunchAtLogin
                ? '当前系统暂不支持'
                : st.launchAtLogin && st.launchAtLoginStale
                  ? undefined
                  : '登录电脑后自动启动软件（隐藏窗口，只在托盘/菜单栏），并随之启动引擎。需要电脑设置了自动登录，才能在断电重启后无人值守恢复'
            }
          >
            <Check checked={st.launchAtLogin} disabled={!st.canLaunchAtLogin} onChange={(v) => void appBridge!.appAction('setLaunchAtLogin', v)} label="开机自动启动" />
            {st.launchAtLogin && st.launchAtLoginStale && (
              <div className="hint err">
                已登记，但登记的程序路径已不存在（软件被移动或删除过）。
                <button style={{ marginLeft: 6 }} onClick={() => void appBridge!.appAction('setLaunchAtLogin', true)}>重新登记</button>
              </div>
            )}
            {!st.isPackaged && <div className="hint">当前是开发版运行：启动项登记的是本目录的 Electron，移动或删除本目录后会失效。</div>}
          </Field>
          <Field label="后台常驻" hint="关闭窗口后界面继续留在托盘/菜单栏，引擎无论如何都在后台独立运行">
            <Check checked={st.keepInTray} onChange={(v) => void appBridge!.appAction('setKeepInTray', v)} label={`关闭窗口后留在${st.isMac ? '菜单栏' : '托盘'}`} />
          </Field>
        </div>
      )}
    </>
  );
}


// ───────────── 编辑锁 ─────────────

function LockSection() {
  const lock = useStore((s) => s.lock);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const locked = lock.enabled && !lock.unlocked;
  const clear = () => { setCur(''); setPw(''); setPw2(''); };

  const save = async () => {
    const bad = checkNewPassword(pw, pw2);
    if (bad) return setMsg({ text: bad, bad: true });
    const err = await setLockPassword(pw, lock.enabled ? cur : undefined);
    setMsg(err ? { text: err, bad: true } : { text: lock.enabled ? '密码已修改' : '编辑锁已启用', bad: false });
    if (!err) clear();
  };
  const remove = async () => {
    if (!window.confirm('移除编辑锁？之后任何人都能修改配置。')) return;
    const err = await removeLockPassword(cur);
    setMsg(err ? { text: err, bad: true } : { text: '编辑锁已移除', bad: false });
    if (!err) clear();
  };

  return (
    <>
      <div className="sech" style={{ marginTop: 16 }}>编辑锁</div>
      <div className="hint pad">
        防止别人随手改日程。上锁后只能查看和急停，修改配置、测试发送、切换配置、停止引擎都要先输入密码；界面闲置 10 分钟自动重新上锁。
        密码只存加盐哈希、保存在这台电脑上；忘记密码时，先停掉引擎，再运行 <code>node src/cli.ts reset-lock</code>。
      </div>
      {locked ? (
        <div className="row" style={{ gap: 8 }}>
          <span className="hint">当前已锁定（要修改密码需先解锁）</span>
          <button onClick={openUnlock}>解锁…</button>
        </div>
      ) : (
        <div className="form wide">
          {lock.enabled && <Field label="当前密码"><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>}
          <Field label={lock.enabled ? '新密码' : '设置密码'}><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="至少 4 个字符" /></Field>
          <Field label="再输一次"><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          <Field label="">
            <span className="row">
              <button className="primary" disabled={!pw} onClick={save}>{lock.enabled ? '修改密码' : '启用编辑锁'}</button>
              {lock.enabled && <button onClick={() => void lockNow()}>立即锁定</button>}
              {lock.enabled && <button className="danger" disabled={!cur} onClick={remove}>移除编辑锁</button>}
              {msg && <span className={`hint ${msg.bad ? 'err' : 'okc'}`}>{msg.text}</span>}
            </span>
          </Field>
        </div>
      )}
    </>
  );
}

// ───────────── 配置备份 ─────────────

function BackupSection() {
  return (
    <>
      <div className="sech" style={{ marginTop: 16 }}>配置备份</div>
      <div className="hint pad">每次保存前自动备份旧版本（至少间隔 1 分钟，保留 30 份）。改坏了可以恢复到之前的样子。</div>
      <button onClick={openBackups}>从备份恢复…</button>
    </>
  );
}
