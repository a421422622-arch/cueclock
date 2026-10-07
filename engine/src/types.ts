// CueClock 引擎数据模型。项目文件就是这个结构的 JSON。
import type { ChecksumSpec } from './checksum.ts';

export type PayloadFormat = 'ascii' | 'hex';
/** 发送内容的格式：ascii / hex，或 osc（内容写成「地址 参数…」，引擎生成 OSC 1.0 字节，见 osc.ts；只支持 UDP） */
export type SendFormat = PayloadFormat | 'osc';
export type Terminator = 'none' | 'cr' | 'lf' | 'crlf';
export type MatchKind = 'exact' | 'prefix' | 'contains' | 'regex';
export type DayKind = 'workday' | 'makeupWorkday' | 'weekend' | 'holiday';

/**
 * 设备在线检测。mode：
 *  - ping：调系统 ping，只说明网络层通不通（设备屏蔽 ICMP 会误报，设备程序死了也可能仍能 ping 通）；
 *  - udp：发一条探测指令并校验回包，最准，但设备必须会回。探测指令必须由用户明确选择（只读的状态查询），软件绝不自动挑。
 */
export interface DeviceHealthConfig {
  mode: 'ping' | 'udp';
  /** 探测间隔（秒），5~3600，默认 30 */
  intervalSec?: number;
  /** 单次探测超时（毫秒）。ping 默认 2000；udp 用探测指令自己的回包超时 */
  timeoutMs?: number;
  /** udp 模式：用哪条指令探测（必须开启回包校验）；参数用默认值或这里给的值 */
  probe?: { commandId: string; args?: Record<string, string> };
}

export interface DeviceFeedbackConfig {
  /** 已校验回包中的状态正则；ASCII 按字节解码，HEX 按大写连续十六进制解析。 */
  format: PayloadFormat;
  pattern: string;
  fields: { label: string; group: number }[];
  /** 多久未刷新视为过期，默认 60000ms。 */
  staleMs?: number;
}

export interface Device {
  id: string;
  name: string;
  /** 在线检测（可选）。不设置 = 不主动检测 */
  health?: DeviceHealthConfig;
  feedback?: DeviceFeedbackConfig;
  /** PJLink 密码（设备没设密码就留空）。明文存在配置文件里——这是投影机的网络控制口令，不是账号密码；别在这里填重要密码 */
  password?: string;
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

/**
 * 传输协议。udp（默认，旧项目没有这个字段）；tcp：每次发送新建一个连接，发完（等完回包）就关；
 * pjlink：TCP + PJLink 握手认证（投影机/显示器行业标准，默认端口 4352，ASCII，以 CR 结尾）。
 * 动作类型名仍叫 `udp`（历史原因），实际由 protocol 决定怎么发。只做出站连接，不新增任何入站监听。
 */
export type SendProtocol = 'udp' | 'tcp' | 'pjlink';
export const PJLINK_PORT = 4352;

export interface UdpAction {
  id: string;
  type: 'udp';
  protocol?: SendProtocol;
  /** 在内容后追加校验字节（Sum8 / XOR8 / CRC16…），见 checksum.ts */
  checksum?: ChecksumSpec;
  /** 引擎展开场景时生成，供执行进度关联。 */
  sceneStep?: { refId: string; sceneId: string; name: string; index: number; names: string[] };
  enabled?: boolean;
  /** 设备 id，或 "tag:标签名" */
  targets: string[];
  /** 目标端口；不填用设备的默认端口 */
  port?: number;
  /** 从哪块本机网卡（IP）发；不填按目标所在子网自动选择 */
  sendFrom?: string;
  /** 由指令展开而来时，记下指令名（日志/预览显示用） */
  commandName?: string;
  format: SendFormat;
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
  protocol?: SendProtocol;
  checksum?: ChecksumSpec;
  format: SendFormat;
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
  /** timed 为原有偏移日程；sequence 按列表顺序等待每一步结果。 */
  execution?: 'timed' | 'sequence';
  onFailure?: 'stop' | 'continue';
  actions: Action[];
}

/** 引用场景。offsetMs 让整个场景相对事件点整体后移。 */
export interface SceneAction {
  id: string;
  type: 'scene';
  enabled?: boolean;
  sceneId: string;
  offsetMs?: number;
  /** 展开时捕获的场景快照，输入项目里的值不会被采用。 */
  resolvedScene?: Scene;
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

/**
 * 操作面板：一块按钮网格，用来现场手动操作（和定时日程并行）。
 * 按钮绑定一串动作（场景/指令/自定义 UDP/延时/时间线控制，复用动作列表）。
 * 开关有「开」「关」两组动作，亮灯状态是**推测的**（UDP 设备大多不回报，只记「上次按的是开还是关」）。
 * 单选组（group）：同组按钮点哪个哪个亮、其余熄灭。
 */
export interface PadTile {
  id: string;
  label: string;
  /** #RRGGBB */
  color?: string;
  kind: 'button' | 'toggle' | 'slider';
  /** 占几列，默认 1 */
  size?: 1 | 2;
  /** 单选组名，只用于按钮 */
  group?: string;
  /** 点击前先让操作员确认（界面侧；如「全关」） */
  confirm?: boolean;
  /** 操作时接管目标设备的秒数，期间自动动作跳过；不填保持原行为。 */
  takeoverSec?: number;
  /** 按钮：点击时执行；开关：切到「开」时执行 */
  actions: Action[];
  /** 开关：切到「关」时执行 */
  offActions?: Action[];
  /**
   * 滑块（调光一类的范围值）：拖动时把当前值代入 actions 里的 {{value}}（十进制）/ {{hex}}（十六进制，偶数位）再发送。
   * 范围是**发给设备的原始值**（如 0~255 或 0~100），默认 0~100、步长 1。`initial` 只是界面首次显示的位置，不会发送。
   */
  min?: number;
  max?: number;
  step?: number;
  initial?: number;
  /** 操作员看到的单位（如 %、dB）。 */
  unit?: string;
  /** UI范围线性映射到设备值；precision默认0（取整），不填mapping保持旧原始值。 */
  mapping?: { min: number; max: number; precision?: number };
  /** 显示设备真实状态：按钮的亮灭 / 数值 / 文字来自设备回读，而不是「最后按了什么」。设备需要配置回读解析（Device.feedback）并定期刷新（UDP 探测检测）。 */
  feedback?: PadTileFeedback;
}

export interface PadTileFeedback {
  deviceId: string;
  /** 设备回读字段名（Device.feedback.fields[].label） */
  field: string;
  /** 开关：回读值等于其中任何一个就算「开」（不区分大小写、忽略首尾空格）。滑块 / 按钮不用 */
  on?: string[];
}

export interface Pad {
  id: string;
  name: string;
  /** 每行几个，1~8，默认 4 */
  columns?: number;
  tiles: PadTile[];
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
  /** 告警相关。offlineAfter：设备连续多少次回包最终失败，判定为离线（默认 3） */
  alerts?: { offlineAfter?: number };
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
  pads?: Pad[];
  groups: Group[];
  timelines: Timeline[];
  triggers: Trigger[];
  calendar?: CalendarData;
  settings?: ProjectSettings;
}
