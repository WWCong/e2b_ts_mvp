/**
 * 事件流：内核在每个状态转换点产生事件，按序交给所有订阅者（9.1）。
 * 内核只写不读回，投递去向由订阅者（投递插件）决定（R25）。
 */

import type { Result } from "./run";

/** 后续加入：run.waiting、run.killed、park.opened / park.closed、装饰器处置、快照与恢复等 */
export type EventBody =
  | { type: "run.started"; runId: string; operation: string; input: unknown }
  | { type: "run.exited"; runId: string; operation: string; result: Result };

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
