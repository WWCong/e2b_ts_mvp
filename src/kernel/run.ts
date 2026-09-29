/**
 * Run：Operation 的一次执行，由状态机管理（3.4）。
 */

/** 后续加入：waiting（等子 Run / 等 unpark）、killed（取消） */
export type RunStatus = "init" | "running" | "exited";

/** 拒绝结果：管控短路与执行失败都以调用结果返回，不抛异常（R16） */
export type Rejected = { ok: false; by: string; reason: string; retryable: boolean };

export type Result = { ok: true; value: unknown } | Rejected;

export type Run = {
  readonly runId: string;
  readonly operation: string;
  readonly input: unknown;
  status: RunStatus;
  // 后续按需加入（附 A）：depth / parent / spawnedBy、operations（能力面）、
  // context、limits、counters、replaying、calls
};

/** 合法转换。init → running 的时刻后续即「进入装饰器链」 */
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
