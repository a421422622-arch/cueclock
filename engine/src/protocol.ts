// 引擎 ⇄ 界面 的本机通信协议：TCP(127.0.0.1) 上的 JSON 行，每行一个消息。
//   请求   {"id":1,"method":"status","params":{...}}
//   响应   {"id":1,"ok":true,"result":...}  或  {"id":1,"ok":false,"error":{"code","message","details"}}
//   事件   {"event":"log","data":...}（引擎主动推送，认证后才会收到）
// 第一条消息必须是 hello（带令牌），否则连接被断开。

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 47800;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; details?: unknown } };

export interface EventMessage {
  event: string;
  data: unknown;
}

export type ErrorCode =
  | 'bad-request'
  | 'locked'
  | 'bad-password'
  | 'too-many-attempts'
  | 'unauthorized'
  | 'not-found'
  | 'invalid-project'
  | 'conflict'
  | 'engine-down'
  | 'timeout'
  | 'disconnected'
  | 'internal'
  | 'incompatible-version';

export class RpcError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** 写在状态目录 daemon.json 里，界面据此找到引擎。 */
export interface DaemonInfo {
  protocol: number;
  engineVersion?: string;
  engineBuild?: string;
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  projectFile: string;
}

/** 按 \n 切行；单行超限视为攻击/故障，抛错让调用方断开连接。 */
export class LineReader {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    if (this.buf.length > MAX_LINE_BYTES || lines.some((l) => l.length > MAX_LINE_BYTES)) {
      throw new RpcError('bad-request', '消息过长');
    }
    return lines.filter((l) => l.trim() !== '');
  }
}
