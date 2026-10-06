// CueClock 引擎数据模型。项目文件就是这个结构的 JSON。

export type PayloadFormat = 'ascii' | 'hex';
export type Terminator = 'none' | 'cr' | 'lf' | 'crlf';
export type MatchKind = 'exact' | 'prefix' | 'contains' | 'regex';
export type DayKind = 'workday' | 'makeupWorkday' | 'weekend' | 'holiday';

export interface Device {
  id: string;
  name: string;
  /** 界面中目标小时间轴的颜色（#RRGGBB），不影响发送。 */
  color?: string;
  ip: string;
  /** 默认端口，可不填。指令/动作里填了端口就以它们为准 */
  port?: number;
  format?: PayloadFormat; // 默认格式，仅用于界面预填
  terminator?: Terminator; // ASCII 默认结束符
  tag?: string;
  enabled?: boolean;
}

export interface MatchSpec {
  kind: MatchKind;
  format: PayloadFormat;
  pattern: string;
}

/** 回包校验：开了才对比；没有这个字段就只记"已发送"。 */
export interface ReplyCheck extends MatchSpec {
  timeoutMs: number;
  retries: number; // 失败后重发次数
}

export interface UdpAction {
  id: string;
  type: 'udp';
  enabled?: boolean;
  /** 设备 id，或 "tag:标签名" */
  targets: string[];
  /** 目标端口；不填用设备的默认端口 */
  port?: number;
  /** 从哪块本机网卡（IP）发；不填按目标所在子网自动选择 */
  sendFrom?: string;
  /** 由指令展开而来时，记下指令名（日志/预览显示用） */
  commandName?: string;
  format: PayloadFormat;
  payload: string;
  terminator?: Terminator; // 缺省取设备的结束符
  offsetMs?: number; // 相对事件点
  repeat?: number; // 开了回包校验时忽略，改用 retries
  repeatGapMs?: number;
  reply?: ReplyCheck | null;
  /** 断电重启后是否补发（默认 false） */
  chase?: boolean;
}

export interface DelayAction {
  id: string;
  type: 'delay';
  enabled?: boolean;
  ms: number;
}

export interface TimelineControlAction {
  id: string;
  type: 'timeline';
  enabled?: boolean;
  op: 'enable' | 'disable';
  /** 时间线 id 或组 id */
  target: string;
  /** 仅对 disable 有意义。restart（默认）：一直禁用到再次启用或引擎重启；midnight：只禁用到今天午夜，自动恢复 */
  until?: 'restart' | 'midnight';
}

/** 指令库里的参数：内容里写 {{名字}}，使用指令时填值，没填用默认值。 */
export interface CommandParam {
  name: string;
  label?: string;
  default?: string;
}

/**
 * 指令：把一条要发送的 UDP 内容配好，存在指令库里，时间线/触发器上的动作直接选用。
 * 目标、端口、内容、回包、重复、断电恢复都在这里设置一次。
 */
export interface Command {
  id: string;
  name: string;
  note?: string;
  targets: string[];
  port?: number;
  sendFrom?: string;
  format: PayloadFormat;
  payload: string;
  terminator?: Terminator;
  params?: CommandParam[];
  repeat?: number;
  repeatGapMs?: number;
  reply?: ReplyCheck | null;
  chase?: boolean;
}

/** 引用指令库里的指令。可覆盖偏移、参数值，以及（可选）目标和端口。 */
export interface CommandAction {
  id: string;
  type: 'command';
  enabled?: boolean;
  commandId: string;
  args?: Record<string, string>;
  offsetMs?: number;
  targets?: string[];
  port?: number;
}

/**
 * 场景：一组命名的动作（UDP、指令、延时），在时间线/触发器里用一个「使用场景」动作整体引用。
 * 场景自成一条小时间线：内部的延时只作用于场景内部，不会顺延场景外面的动作。
 * 场景里不能再套场景，也不能放「时间线控制」（避免递归和作用域歧义）。
 */
export interface Scene {
  id: string;
  name: string;
  note?: string;
  actions: Action[];
}

/** 引用场景。offsetMs 让整个场景相对事件点整体后移。 */
export interface SceneAction {
  id: string;
  type: 'scene';
  enabled?: boolean;
  sceneId: string;
  offsetMs?: number;
}

export type Action = UdpAction | CommandAction | SceneAction | DelayAction | TimelineControlAction;

export interface Cue {
  id: string;
  name: string;
  /** 从目标轨道新建时的默认目标，仅用于新动作预填，发送仍以动作的 targets 为准。 */
  defaultTarget?: string;
  /** HH:MM、HH:MM:SS 或 HH:MM:SS.mmm */
  time: string;
  enabled?: boolean;
  actions: Action[];
}

/**
 * 生效规则。没写任何"包含"条件 = 每天。
 * 写了多个包含条件（weekdays / dateRanges / dates / dayKinds）= 满足任意一个即可；
 * excludeDates 永远优先。
 */
export interface Rule {
  weekdays?: number[]; // 0=周日 … 6=周六
  dateRanges?: { from: string; to: string }[]; // YYYY-MM-DD，含首尾
  dates?: string[];
  dayKinds?: DayKind[];
  excludeDates?: string[];
}

export interface Group {
  id: string;
  name: string;
  /** exclusive：当天只跑优先级最高的一条；parallel：命中的都跑 */
  mode: 'exclusive' | 'parallel';
}

export interface Timeline {
  id: string;
  name: string;
  /** 界面中的日程模式主时间轴颜色（#RRGGBB）。 */
  color?: string;
  groupId?: string;
  enabled?: boolean;
  /** 数字越小优先级越高，缺省 100 */
  priority?: number;
  rule?: Rule;
  cues: Cue[];
}

export interface Trigger {
  id: string;
  name: string;
  port: number;
  /** IPv4、CIDR（192.168.10.0/24），或 "*" 表示任意来源。空数组 = 全部拒绝 */
  allowFrom: string[];
  /** 口令前缀（ASCII）。匹配前先剥离；UDP 明文，只能防误触 */
  passcode?: string;
  match: MatchSpec;
  actions: Action[];
  debounceMs?: number;
  maxPerMinute?: number;
  /** 需要二次确认：窗口内收到第二个匹配包才执行 */
  requireConfirm?: boolean;
  confirmWindowMs?: number;
}

export interface CalendarData {
  /** 日期 → 节日名 */
  holidays?: Record<string, string>;
  /** 调休上班日 */
  makeupWorkdays?: string[];
}

export interface ProjectSettings {
  recovery?: { enabled?: boolean; delayMs?: number };
  /** 发送套接字绑定，回包要从同一个本地端口收 */
  localAddress?: string;
  localPort?: number;
  /** 错过多久以上的事件不再补执行（系统休眠唤醒等），默认 5000ms */
  maxLateMs?: number;
}

export interface Project {
  name: string;
  devices: Device[];
  commands?: Command[];
  scenes?: Scene[];
  groups: Group[];
  timelines: Timeline[];
  triggers: Trigger[];
  calendar?: CalendarData;
  settings?: ProjectSettings;
}
