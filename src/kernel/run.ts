/**
 * Run：Operation 的一次执行，由状态机管理（3.4）。
 */

/** waiting：在等子 Run 或等 unpark（ctx.park）；killed：被杀（取消或关停） */
export type RunStatus = "init" | "running" | "waiting" | "exited" | "killed";

/** 拒绝结果：管控短路与执行失败都以调用结果返回，不抛异常（R16） */
export type Rejected = { ok: false; by: string; reason: string; retryable: boolean };

export type Result = { ok: true; value: unknown } | Rejected;

/** 交给模型的一项工具：公开 Operation 的名字、说明（usage）与入参 JSON Schema */
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * 内核交给实现与装饰器的句柄，绑定在一个 Run 上。
 * 后续加入：spawn、emit，以及 depth、replaying 等只读信息。
 */
export type Ctx = {
  /** 发起这个 Run 的子调用并等它返回；拒绝作为结果返回（5.3） */
  call(name: string, input: unknown): Promise<Result>;
  /** Run 被杀（取消或关停）时 abort。传给 fetch、子进程等支持它的 API，IO 当场中止 */
  signal: AbortSignal;
  /** 这个 Run 能力面里的公开 Operation，按名字排序（逐字节稳定）。装饰器的 ctx 没有它（8.1） */
  tools(): ToolSpec[];
  /**
   * 挂起这个 Run：转 waiting、发 park.opened，等外部经 unpark 送来一个符合 schema（JSON Schema）的值并返回它；
   * 被撤回时抛异常。payload 随 park.opened 交给外部，内核不解释（3.5）。
   * 一般不直接用，而是调 park Operation（stdlib_park），好让装饰器看得到这次挂起。装饰器的 ctx 没有它。
   */
  park(req: { schema: Record<string, unknown>; payload: unknown }): Promise<unknown>;
};

/** 把异常或原因转成拒绝结果 */
export function reject(by: string, cause: unknown): Rejected {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, by, reason, retryable: false };
}

export type Run = {
  readonly runId: string;
  readonly operation: string;
  /** 冻结前装饰器可以整体替换 */
  input: unknown;
  status: RunStatus;
  /** 外部发起为 0，子 Run 加一 */
  readonly depth: number;
  /** 父 Run 的 runId；根 Run 没有 */
  readonly parent?: string;
  // 后续按需加入（附 A）：spawnedBy、operations（能力面）、
  // context、limits、counters、replaying、calls
};

/** 合法转换。init → running 即进入装饰器链 */
const NEXT: Record<RunStatus, readonly RunStatus[]> = {
  init: ["running"],
  running: ["waiting", "exited", "killed"],
  waiting: ["running", "killed"],
  exited: [],
  killed: [],
};

export function transition(run: Run, to: RunStatus): void {
  if (!NEXT[run.status].includes(to)) {
    throw new Error(`illegal transition ${run.status} -> ${to} (run ${run.runId})`);
  }
  run.status = to;
}

/**
 * 配置冻结：装饰器链走到实现的那一刻起，Run 的配置不可再改（3.4）。
 * 之后再赋值会抛 TypeError（ES module 为严格模式）。后续 context、operations 一并冻结。
 */
export function freeze(run: Run): void {
  Object.defineProperty(run, "input", { writable: false });
}
