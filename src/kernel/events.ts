/**
 * 事件流：内核在每个状态转换点产生事件，按序交给所有订阅者（9.1）。
 * 内核只写不读回，投递去向由订阅者（投递插件）决定（R25）。
 */

import type { OnError } from "./chain";
import type { Rejected, Result } from "./run";

type Link = { runId: string; operation: string; decorator: string };

/** 后续加入：恢复 */
export type EventBody =
  /** chain：这个 Run 的装饰器链序，从外到内 */
  | { type: "run.started"; runId: string; operation: string; input: unknown; parent?: string; depth: number; chain: string[] }
  | { type: "run.exited"; runId: string; operation: string; result: Result }
  /** 被杀（自己或祖先被取消，或关停）；之后这个 Run 不再有 run.exited。reason：cancelled 或 shutdown */
  | { type: "run.killed"; runId: string; operation: string; reason: string }
  /** 内核在建子 Run 之前就拒绝了这次调用（目标不存在、不在能力面、超出保险丝、入参不符等）；runId 是发起方 */
  | { type: "call.rejected"; runId: string; target: string; input: unknown; result: Rejected }
  /** Run 经 ctx.park 开始等待；runId 即 unpark 用的 id。payload 内核不解释，由 UI 等外部按约定格式理解（3.5） */
  | { type: "park.opened"; runId: string; schema: Record<string, unknown>; payload: unknown }
  /** 不再等待：unpark 送来了值、被撤回，或 Run 被取消；关停不算（见 Kernel.stop）。result 是 park 这次的产出 */
  | { type: "park.closed"; runId: string; result: Result }
  /** 树空闲，写了快照（空闲期间记录有变会再写一次）；runId 是根 */
  | { type: "snapshot.written"; runId: string }
  /** 树要重新活跃，先删了快照；runId 是根 */
  | { type: "snapshot.deleted"; runId: string }
  | ({ type: "decorator.rewrote"; phase: "input" | "result"; value: unknown } & Link)
  | ({ type: "decorator.rejected"; result: Rejected } & Link)
  | ({ type: "decorator.failed"; onError: OnError; error: string } & Link);

/** 单调序号 + 时间戳；冗余自足，单看一条就是完整事实 */
export type HarnessEvent = EventBody & { seq: number; ts: number };

export type Subscriber = (event: HarnessEvent) => void;

export class EventStream {
  private seq = 0;
  private readonly subscribers: Subscriber[] = [];

  subscribe(fn: Subscriber): void {
    this.subscribers.push(fn);
  }

  emit(body: EventBody): void {
    const event: HarnessEvent = { ...body, seq: ++this.seq, ts: Date.now() };
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
