import type { BrowserWindow } from 'electron';
import dgram from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { waitForLogDelivery, activeFrameWindow, assertLogPerformance, frameStats } from './logPerformance.ts';

type Request = <T>(method: string, params?: unknown) => Promise<T>;

/** testSend仅发给本函数绑定的127.0.0.1动态UDP端口，真实引擎→TCP→IPC→React。 */
export async function smokeLogPerformance(win: BrowserWindow, request: Request, outputDir?: string) {
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sink = dgram.createSocket('udp4');
  let tag = '', udpReceived = 0;
  sink.on('message', (b) => { if (b.toString().startsWith(tag)) udpReceived++; });
  await new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.bind(0, '127.0.0.1', resolve); });
  const port = (sink.address() as { port: number }).port;
  const visible = win.isVisible();
  const samples = [];
  if (outputDir) mkdirSync(outputDir, { recursive: true });
  if (!visible) win.showInactive(); // 隐藏窗口的后台节流不代表实际使用时的帧率。
  try {
    for (const width of [1440, 1100]) for (const view of ['运行总览', '模式与时间轴']) {
      win.setSize(width, width === 1440 ? 900 : 700);
      await js(`(() => { const e=[...document.querySelectorAll('.viewtabs > span')].find(e=>e.textContent.trim()===${JSON.stringify(view)}); if(!e)throw Error('压力页面不存在'); e.click(); })()`);
      await sleep(900);
      tag = `CC-SMOKE-LOG-${width}-${view === '运行总览' ? 'overview' : 'timeline'}-`;
      udpReceived = 0;
      await js(`(() => {
        if(document.visibilityState!=='visible') throw Error('帧率测量窗口不可见');
        if(!document.querySelector('.savestate.dirty') || !document.querySelector('.estop').textContent.includes('自动已暂停')) throw Error('帧率测量没有草稿和暂停压力');
        const alarm=document.querySelector('.alertpill'); if(!alarm)throw Error('缺少告警压力');
        [...alarm.childNodes].find(n=>n.nodeType===Node.TEXT_NODE).textContent='99999';
        const p=window.__cueclockLogPerf={spans:[],received:0,lastLog:'',start:performance.now(),last:null};
        p.off=window.cueclock.onEvent(m=>{if(m.event==='log' && m.data.ascii?.startsWith(${JSON.stringify(tag)})){p.received++;p.lastLog=m.data.ascii;}});
        const frame=t=>{if(p.last!==null)p.spans.push({startMs:p.last-p.start,endMs:t-p.start});p.last=t;p.raf=requestAnimationFrame(frame);};p.raf=requestAnimationFrame(frame);
      })()`);
      const requests: Promise<unknown>[] = [], errors: string[] = [];
      let sent = 0;
      const start = performance.now();
      // 按墙上已过去的时间补齐应发数量，避免Node定时器约11ms一次的累计漂移。
      const sendDue = () => {
        const due = Math.min(300, Math.floor((performance.now() - start) / 10));
        while (sent < due) {
          const payload = `${tag}${++sent}`;
          requests.push(request<{ result: string }>('testSend', { ip: '127.0.0.1', port, format: 'ascii', payload, terminator: 'none' })
            .then((r) => { if (r.result !== 'sent') errors.push(r.result); }).catch((e) => { errors.push(String(e)); }));
        }
      };
      const timer = setInterval(sendDue, 10);
      try { await sleep(3000); } finally { clearInterval(timer); sendDue(); }
      const trafficMs = performance.now() - start;
      await Promise.all(requests);
      const settleStart = performance.now();
      let settleError: string | null = null;
      try {
        await waitForLogDelivery(async () => {
          const state = await js<{ received: number; lastInDOM: boolean }>(`({received:window.__cueclockLogPerf.received,lastInDOM:[...document.querySelectorAll('.logbody .ln .c')].some(e=>e.textContent===${JSON.stringify(tag + sent)})})`);
          return state.received === sent && udpReceived === sent && state.lastInDOM;
        });
      } catch (e) { settleError = (e as Error).message; }
      const settleWaitMs = performance.now() - settleStart;

      const measured = await js<{ spans: { startMs: number; endMs: number }[]; received: number; probeMs: number; renderedLast: boolean; visible: string }>(`(() => {
        const p=window.__cueclockLogPerf;cancelAnimationFrame(p.raf);p.off();
        const result={spans:p.spans,received:p.received,probeMs:performance.now()-p.start,visible:document.visibilityState,
          renderedLast:[...document.querySelectorAll('.logbody .ln .c')].some(e=>e.textContent===${JSON.stringify(tag + sent)})};
        delete window.__cueclockLogPerf;return result;
      })()`);
      const sample = { width, view, ...measured, ...activeFrameWindow(measured.spans, trafficMs), frameMs: trafficMs, trafficMs, sent, udpReceived, errors, settleWaitMs, settleError };
      samples.push({ ...sample, frames: { ...frameStats(sample.intervals), maxMs: sample.maxGapMs }, logsPerSec: sent / (trafficMs / 1000) });
      assertLogPerformance(sample);
      if (settleError) throw new Error(settleError);
      if (errors.length) throw new Error(`日志压力请求失败：${errors.join(', ')}`);
      if (outputDir) writeFileSync(path.join(outputDir, `${width}-${view}.png`), (await win.webContents.capturePage()).toPNG());
    }
    return { passed: true, samples };
  } finally {
    await js(`(() => { const p=window.__cueclockLogPerf;if(p){cancelAnimationFrame(p.raf);p.off();delete window.__cueclockLogPerf;} })()`).catch(() => {});
    sink.close();
    // 自检结束由main退出窗口；此处重新隐藏会让后续截断检查的rAF被后台节流挂起。
    if (outputDir) writeFileSync(path.join(outputDir, 'log-performance.json'), JSON.stringify({ samples }, null, 2));
  }
}
