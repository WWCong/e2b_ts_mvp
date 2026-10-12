/**
 * 事件流：内核在每个状态转换点产生事件，按序交给所有订阅者（9.1）。
 * 内核只写不读回，投递去向由订阅者（投递插件）决定（R25）。
 */

import type { OnError } from "./chain";
import type { Recorded } from "./journal";
import type { Rejected, Result } from "./run";

type Link = { runId: string; operation: string; decorator: string };

/** 日志里一条已完成的记录：runId 的第 seq 步 */
export type Replayed = { runId: string; seq: number } & Recorded;

export type EventBody =
  /**
   * chain：这个 Run 的装饰器链序，从外到内；callSeq：它是父的第几个调用，即日志 call 行的 seq（根 Run 没有）；
   * attempt：崩溃恢复后重新执行时才有，第几次执行
   */
  | {
      type: "run.started";
      runId: string;
      operation: string;
      input: unknown;
      parent?: string;
      callSeq?: number;
      depth: number;
      chain: string[];
      attempt?: number;
    }
  | { type: "run.exited"; runId: string; operation: string; result: Result }
  /** 被杀（自己或祖先被取消，或关停，或恢复失败）；之后这个 Run 不再有 run.exited。reason：cancelled、shutdown、diverged …，或根建不起来的原因 */
  | { type: "run.killed"; runId: string; operation: string; reason: string }
  /** 内核在建子 Run 之前就拒绝了这次调用（目标不存在、不在能力面、超出保险丝、入参不符等）；runId 是发起方 */
  | { type: "call.rejected"; runId: string; target: string; input: unknown; result: Rejected }
  /** Run 经 ctx.park 开始等待；runId 即 unpark 用的 id。payload 内核不解释，由 UI 等外部按约定格式理解（3.5） */
  | { type: "park.opened"; runId: string; schema: Record<string, unknown>; payload: unknown }
  /** 不再等待：unpark 送来了值、被撤回，或 Run 被取消；关停不算（见 Kernel.stop）。result 是 park 这次的产出 */
  | { type: "park.closed"; runId: string; result: Result }
  /**
   * 从写前日志恢复了一棵树，runId 是根。replayed：日志里已完成的调用与 park（带结果），重放时不再发事件，
   * 崩溃前没来得及发的 run.exited、park.closed 据此补齐；inflight：崩溃时正在执行、要重新执行的 Run（含根）；
   * artifactChanged：装配的产物与写日志时不同，只提示，逐个调用比对兜底
   */
  | { type: "tree.recovered"; runId: string; replayed: Replayed[]; inflight: string[]; artifactChanged: boolean }
  | ({ type: "decorator.rewrote"; phase: "input" | "result"; value: unknown } & Link)
  | ({ type: "decorator.rejected"; result: Rejected } & Link)
  | ({ type: "decorator.failed"; onError: OnError; error: string } & Link);

/**
 * boot：这次启动的 id，按时间有序（UUIDv7），换了 boot 即重启过；seq：本次启动内单调的序号；ts：时间戳。
 * 重启后 seq 从头数，下游按「boot + seq」排序。冗余自足，单看一条就是完整事实
 */
export type HarnessEvent = EventBody & { boot: string; seq: number; ts: number };

export type Subscriber = (event: HarnessEvent) => void;

export class EventStream {
  readonly boot = Bun.randomUUIDv7();
  private seq = 0;
  private readonly subscribers: Subscriber[] = [];

  subscribe(fn: Subscriber): void {
    this.subscribers.push(fn);
  }

  emit(body: EventBody): void {
    const event: HarnessEvent = { ...body, boot: this.boot, seq: ++this.seq, ts: Date.now() };
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // 订阅者出错不影响 Run 与其他订阅者
        console.error(`[harness] subscriber failed on event #${event.seq}`, err);
      }
    }
  }
}
