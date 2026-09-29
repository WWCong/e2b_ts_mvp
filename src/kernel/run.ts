/**
 * Run：Operation 的一次执行，由状态机管理（3.4）。
 */

/** 后续加入：waiting（等子 Run / 等 unpark）、killed（取消） */
export type RunStatus = "init" | "running" | "exited";

/** 拒绝结果：管控短路与执行失败都以调用结果返回，不抛异常（R16） */
export type Rejected = { ok: false; by: string; reason: string; retryable: boolean };

export type Result = { ok: true; value: unknown } | Rejected;

/** 把异常转成拒绝结果 */
export function reject(by: string, err: unknown): Rejected {
  const reason = err instanceof Error ? err.message : String(err);
  return { ok: false, by, reason, retryable: false };
}

export type Run = {
  readonly runId: string;
  readonly operation: string;
  /** 冻结前装饰器可以整体替换 */
  input: unknown;
  status: RunStatus;
  // 后续按需加入（附 A）：depth / parent / spawnedBy、operations（能力面）、
  // context、limits、counters、replaying、calls
};

/** 合法转换。init → running 即进入装饰器链 */
const NEXT: Record<RunStatus, readonly RunStatus[]> = {
  init: ["running"],
  running: ["exited"],
  exited: [],
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
