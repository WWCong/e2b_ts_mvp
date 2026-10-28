/**
 * 事件流：内核在每个状态转换点产生事件，按序交给所有订阅者（9.1）。
 * 内核只写不读回，投递去向由订阅者（投递插件）决定（R25）。
 * 交给订阅者之前先过提交阶段：写前日志据事件同步落盘（journal.ts），插件看不到、拦不了。
 */

import type { OnError } from "./chain";
import type { Recorded } from "./journal";
import type { Rejected, Result } from "./run";

type Link = { runId: string; operation: string; decorator: string };

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 日志里一条已完成的记录：runId 的第 seq 步 */
export type Replayed = { runId: string; seq: number } & Recorded;

export type EventBody =
  /**
   * input：调用方给的入参，原样（实现拿到的是按 schema 解析后的）；chain：这个 Run 的装饰器链序，从外到内；
   * step：它是父的第几步，即日志的序号（根 Run 没有）；attempt：崩溃恢复后重新执行时才有，第几次执行；
   * artifact：根 Run 才有，装配的产物摘要；origin：根 Run 才有，这棵树是谁发起的（服务接口给的，如 http:console），宿主直接 submit 的没有
   */
  | {
      type: "run.started";
      runId: string;
      operation: string;
      input: unknown;
      parent?: string;
      step?: number;
      depth: number;
      chain: string[];
      attempt?: number;
      artifact?: string;
      origin?: string;
    }
  | { type: "run.exited"; runId: string; operation: string; result: Result }
  /** 被杀（自己或祖先被取消，或关停，或恢复失败）；之后这个 Run 不再有 run.exited。reason：cancelled、shutdown、diverged …，或根建不起来的原因 */
  | { type: "run.killed"; runId: string; operation: string; reason: string }
  /** 内核在建子 Run 之前就拒绝了这次调用（目标不存在、不在能力面、超出保险丝、入参不符等）；runId 是发起方，step 是它的第几步 */
  | { type: "call.rejected"; runId: string; step: number; target: string; input: unknown; result: Rejected }
  /** Run 经 ctx.park 开始等待；runId 即 unpark 用的 id。payload 内核不解释，由 UI 等外部按约定格式理解（3.5） */
  | { type: "park.opened"; runId: string; schema: Record<string, unknown>; payload: unknown }
  /** 不再等待：unpark 送来了值、被撤回，或 Run 被取消；关停不算（见 Kernel.stop）。step 是这个 Run 的第几步，result 是 park 这次的产出 */
  | { type: "park.closed"; runId: string; step: number; result: Result }
  /**
   * 从写前日志恢复了一棵树，runId 与 operation 是根的，origin 是谁发起的。replayed：日志里已完成的调用与 park（带结果），重放时不再发事件，
   * 崩溃前没来得及发的 run.exited、park.closed 据此补齐；inflight：崩溃时正在执行、要重新执行的 Run（含根）；
   * artifactChanged：装配的产物与写日志时不同，只提示，逐个调用比对兜底
   */
  | {
      type: "tree.recovered";
      runId: string;
      operation: string;
      origin?: string;
      replayed: Replayed[];
      inflight: string[];
      artifactChanged: boolean;
    }
  /**
   * 根 Run 的结果被取走了（reap），或放得太久没人取、启动时清掉了（expired）。之后不再保留，提交阶段删掉它的日志
   */
  | { type: "run.reaped"; runId: string; operation: string; expired?: boolean }
  /**
   * 一行日志（观测级）：Run 经 ctx.log 写的，script 的 console 输出也是。不交给调用方，也不进写前日志；
   * 恢复时重新执行的 Run 回放已完成的步骤期间写的不再发（它们在崩溃前发过）
   */
  | { type: "run.logged"; runId: string; operation: string; level: LogLevel; text: string }
  | ({ type: "decorator.rewrote"; phase: "input" | "result"; value: unknown } & Link)
  | ({ type: "decorator.rejected"; result: Rejected } & Link)
  | ({ type: "decorator.failed"; onError: OnError; error: string } & Link);

/**
 * boot：这次启动的 id，按时间有序（UUIDv7），换了 boot 即重启过；seq：本次启动内单调的序号；ts：时间戳。
 * 重启后 seq 从头数，下游按「boot + seq」排序。冗余自足，单看一条就是完整事实
 */
export type HarnessEvent = EventBody & { boot: string; seq: number; ts: number };

/** 订阅者可以是 async：不等它返回 */
export type Subscriber = (event: HarnessEvent) => unknown;

/** 调一个通知类的回调：不等它，出错（同步抛出或 Promise 拒绝）都只记下，不影响调用方 */
export function notify(what: string, fn: () => unknown): void {
  const failed = (err: unknown) => console.error(`[harness] ${what} failed`, err);
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(failed);
  } catch (err) {
    failed(err);
  }
}

export class EventStream {
  readonly boot = Bun.randomUUIDv7();
  private seq = 0;
  private readonly subscribers: Subscriber[] = [];

  /** commit：提交阶段，每条事件先同步交给它，返回了才交给订阅者；它抛异常（如写盘失败）则转换点失败 */
  constructor(private readonly commit?: (event: HarnessEvent) => void) {}

  subscribe(fn: Subscriber): void {
    this.subscribers.push(fn);
  }

  emit(body: EventBody): void {
    const event: HarnessEvent = { ...body, boot: this.boot, seq: ++this.seq, ts: Date.now() };
    this.commit?.(event);
    // 订阅者出错不影响 Run 与其他订阅者
    for (const fn of this.subscribers) notify(`subscriber on event #${event.seq}`, () => fn(event));
  }
}
