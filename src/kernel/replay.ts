/**
 * 一个 Run 恢复时重新执行的回放：按序号取它在日志里的记录，已完成的结果按原完成顺序逐个交还。
 * 每交还一个，先让代码跑一步（它可能据此发起下一个调用），再交下一个：并发发出的调用（Promise.all、race）
 * 拿到结果的先后与崩溃前一致。
 * 在途重新执行的调用、越过记录末尾的新调用不参与排序，何时完成取决于真实执行。
 */

import type { Recorded, RunLog } from "./journal";
import type { Result } from "./run";

/** 已完成的记录：调用有了结果，或 park 已关闭。代码看过它的结果 */
export function isDone(recorded: Recorded): boolean {
  return recorded.type === "park" || recorded.result !== undefined;
}

export class Replay {
  /** 下一个该交还的完成顺序 */
  private next = 0;
  /** 已发起、等着轮到的：完成顺序 → 交还 */
  private readonly waiting = new Map<number, () => void>();

  constructor(private readonly log: RunLog) {}

  at(seq: number): Recorded | undefined {
    return this.log.entries.get(seq);
  }

  /** 交还一个已完成的结果：轮到它的完成顺序时才兑现 */
  deliver(order: number, result: Result): Promise<Result> {
    return new Promise((resolve) => {
      this.waiting.set(order, () => resolve(result));
      this.flush();
    });
  }

  /** 从第 from 步起没走到的第一个已完成记录：代码已结束却没走到它，它的效果发生过 */
  unreached(from: number): [number, Recorded] | undefined {
    return [...this.log.entries]
      .filter(([seq, recorded]) => seq >= from && isDone(recorded))
      .sort(([a], [b]) => a - b)[0];
  }

  private flush(): void {
    const resolve = this.waiting.get(this.next);
    if (!resolve) return;
    this.waiting.delete(this.next++);
    resolve();
    // 先让拿到结果的代码跑完这一步（微任务），再交下一个
    setImmediate(() => this.flush());
  }
}
