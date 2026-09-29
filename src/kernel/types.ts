/**
 * 内核核心类型：Operation、Run、调用记录、产出与拒绝、包清单。
 * 章节号指 doc/harness-技术方案.md。
 */

// ─── JSON ────────────────────────────────────────────────────────────────

/** Operation 的入参与出参只用 JSON 能表示的类型（7.3） */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type JsonSchema = JsonObject | boolean;

// ─── 名字 ────────────────────────────────────────────────────────────────

/** `包名.函数名`，如 `fs.read`、`video-analysis.completionScore` */
export type OperationName = string;
export type RunId = string;

/** Operation 由谁提供：内核或插件为 native，script 包为 script（3.1） */
export type Form = "native" | "script";

/** 拒绝结果里 `by` 为内核时的取值 */
export const KERNEL = "kernel";

// ─── 产出与拒绝（5.2、R16）────────────────────────────────────────────────

export interface Success<T = Json> {
  ok: true;
  value: T;
}

/** 拒绝是结果，不是异常：管控短路、内核拒绝、实现抛错都以它返回 */
export interface Rejection {
  ok: false;
  /** 谁拒的：装饰器 id、`kernel`，或实现抛错时的 Operation 名 */
  by: string;
  reason: string;
  /** 改一改能否再试：false 让调用方改道，true 让它带着反馈重试 */
  retryable: boolean;
  /** 实现自己抛出的异常，区别于管控拒绝 */
  error?: true;
}

/** 每个 Run 的产出 */
export type Outcome<T = Json> = Success<T> | Rejection;

export function ok<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function rejection(
  by: string,
  reason: string,
  opts: { retryable?: boolean; error?: boolean } = {},
): Rejection {
  const r: Rejection = { ok: false, by, reason, retryable: opts.retryable ?? false };
  if (opts.error) r.error = true;
  return r;
}

/**
 * 强类型 import 的调用遇到拒绝时抛出。`call()` 直接返回 Outcome，不抛。
 */
export class Rejected extends Error {
  override readonly name = "Rejected";
  readonly by: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly error: boolean;

  constructor(r: Rejection) {
    super(`rejected by ${r.by}: ${r.reason}`);
    this.by = r.by;
    this.reason = r.reason;
    this.retryable = r.retryable;
    this.error = r.error === true;
  }

  toRejection(): Rejection {
    return rejection(this.by, this.reason, { retryable: this.retryable, error: this.error });
  }
}

/** 取出成功值，拒绝则抛 `Rejected` */
export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw new Rejected(outcome);
}

// ─── Run 状态机（3.4）────────────────────────────────────────────────────

export type RunStatus = "init" | "running" | "waiting" | "exited" | "killed";

/**
 * - init → running：进入装饰器链
 * - running ⇄ waiting：等子 Run / 等 unpark，返回后回到 running
 * - running → exited：正常结束或被拒绝
 * - running / waiting → killed：取消
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  init: ["running"],
  running: ["waiting", "exited", "killed"],
  waiting: ["running", "killed"],
  exited: [],
  killed: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return status === "exited" || status === "killed";
}

/** kill 只来自取消接口、祖先被 kill、关停与恢复失败（3.4） */
export type KillReason = "cancelled" | "ancestor-killed" | "shutdown" | "restore-failed";

// ─── Run 上的数据（附 A）──────────────────────────────────────────────────

/** 声明的限额，如 `@limits steps=5 tokens=60000`；单位与含义由插件定义，内核不解释 */
export type Limits = Readonly<Record<string, number | string>>;

/** 通用计数槽，谁产生谁累加；内核不汇总、不解释 */
export type Counters = Record<string, number>;

/** 上下文槽：装饰器写入，`model.complete` 渲染 */
export type RunContext = Record<string, Json>;

/** 谁发起了一棵新 Run 树（5.3） */
export type SpawnOrigin =
  /** Operation 本体或装饰器发起；`seq` 指发起方调用记录里的那条 spawn */
  | { runId: RunId; seq: number; decorator?: string }
  /** 处理器发起：没有当前 Run，`event` 是触发它的事件序号 */
  | { handler: string; event: number };

/** 一次子调用：等结果，参与重放 */
export interface InvokeRecord {
  kind: "call";
  /** 本 Run 内的发起序号，从 1 开始；取时间与随机数也占序号 */
  seq: number;
  target: OperationName;
  inputDigest: string;
  /** 由哪个装饰器发起；null 为 Operation 本体 */
  decorator: string | null;
  /** 仅 script：触发它的那次子调用的 seq；入口直接发出的为 null（7.5、R21） */
  after: number | null;
  /** 建立的子 Run；内核在建 Run 之前就拒绝时为 null */
  child: RunId | null;
  /** 完成前为 null */
  outcome: Outcome | null;
  /** 本 Run 内第几个完成，从 1 开始；完成前为 null */
  completion: number | null;
}

/** 一次 spawn：不等结果，恢复时不再发起 */
export interface SpawnRecord {
  kind: "spawn";
  seq: number;
  target: OperationName;
  inputDigest: string;
  decorator: string | null;
  after: number | null;
  /** 新树的根；被拒绝时为 null */
  root: RunId | null;
}

/** script 取到的时间与随机数，重放时原样回送 */
export interface EntropyRecord {
  kind: "now" | "random";
  seq: number;
  value: number;
}

export type CallRecord = InvokeRecord | SpawnRecord | EntropyRecord;

/** Run 的数据面：Run 对象持有、进快照、可 dump 的字段 */
export interface RunRecord {
  runId: RunId;
  operation: OperationName;
  form: Form;
  input: Json;
  status: RunStatus;
  /** 解析后的能力面，Run 内冻结 */
  operations: OperationName[];
  context: RunContext;
  limits: Limits;
  counters: Counters;
  depth: number;
  parent: RunId | null;
  root: RunId;
  spawnedBy: SpawnOrigin | null;
  replaying: boolean;
  calls: CallRecord[];
  /** exited 后才有 */
  outcome: Outcome | null;
}

// ─── 内侧代码看到的 Run ──────────────────────────────────────────────────

/** 实现与装饰器看到的当前 Run（只读视图） */
export interface RunView {
  readonly runId: RunId;
  readonly operation: OperationName;
  readonly form: Form;
  readonly status: RunStatus;
  readonly input: Json;
  readonly operations: readonly OperationName[];
  readonly context: Readonly<RunContext>;
  readonly limits: Limits;
  readonly counters: Readonly<Counters>;
  readonly depth: number;
  readonly parent: RunId | null;
  readonly root: RunId;
  readonly spawnedBy: SpawnOrigin | null;
  readonly replaying: boolean;
  /** 计数槽累加 */
  count(key: string, delta?: number): void;
}

/** 装饰器拿到的 Run：每个装饰器一份，`reject` 的 `by` 由内核填为该装饰器 id */
export interface DecoratedRun extends RunView {
  /** 改入参，只在 `next()` 之前有效；配置冻结后调用抛错 */
  setInput(input: Json): void;
  /** 往上下文槽放条目，只在 `next()` 之前有效 */
  setContext(key: string, value: Json): void;
  /** 生成一个以本装饰器为 `by` 的拒绝结果，直接 return 它即拒绝 */
  reject(reason: string, opts?: { retryable?: boolean }): Rejection;
}

export type OperationFn = (input: any) => Promise<unknown>;
export type Next = () => Promise<Outcome>;
export type DecoratorFn = (run: DecoratedRun, next: Next) => Promise<Outcome>;

// ─── 包清单（6.1、7.3）────────────────────────────────────────────────────

/**
 * 扫描器从包源码生成的清单；内核只认它，不直接读源码。
 * 插件与 script 包同一种格式。
 */
export interface PackageManifest {
  /** 包名，也是 Operation 名的前缀 */
  name: string;
  version: string;
  form: Form;
  /** 包简介：文件顶部的 JSDoc */
  summary: string;
  operations: OperationDecl[];
  decorators: DecoratorDecl[];
  handlers: HandlerDecl[];
}

export interface OperationDecl {
  /** 导出函数名；Operation 名为 `包名.导出名` */
  export: string;
  /** JSDoc 正文 */
  usage: string;
  /** `@public`；script 包导出的恒为 true */
  public: boolean;
  input: JsonSchema;
  output: JsonSchema;
  limits: Limits;
  /** `@decorators`：自选装饰器 id，按书写顺序，外 → 内 */
  decorators: string[];
  /** `@only`：Operation 名或包名；null 为未收窄 */
  only: string[] | null;
  /** `@exclude`：Operation 名或包名 */
  exclude: string[];
}

export interface DecoratorDecl {
  export: string;
  /** `@decorator <id>`：全局唯一，为包名本身或以 `包名.` 开头，如 `budget`、`fs.pathGuard` */
  id: string;
  /** `@onError`：open 出错跳过，closed 出错中断 Run */
  onError: "open" | "closed";
  public: boolean;
  usage: string;
}

export interface HandlerDecl {
  export: string;
  /** `@on <挂点>`：通知类型、生命周期挂点或插件自定义挂点 */
  on: string;
}

// ─── 装配配置里的资源保险丝（3.4、R9）────────────────────────────────────

export interface KernelLimits {
  /** 最大深度 */
  maxDepth: number;
  /** 同时存活的 Run 数 */
  maxLiveRuns: number;
  /** 同时等待的 park 数 */
  maxParks: number;
}

// ─── park（3.5）──────────────────────────────────────────────────────────

export interface ParkInput {
  schema: JsonSchema;
  /** 内核不解释，原样随 `park.opened` 发出 */
  payload: Json;
}

export type ParkResult = { ok: true; value: Json } | { ok: false; reason: string };
