/**
 * stdlib 插件：内核机制的 Operation 形式，与不确定的值，装配时按需装载。
 * 后续加入：random、uuid、exec 等。
 */

import { z } from "zod";
import { op, plugin } from "../../kernel/harness";

export default plugin(() => ({
  operations: {
    /**
     * 挂起：等外部经 unpark 送来一个符合 schema（JSON Schema）的值（3.5）。
     * 等人确认、等外部回调都用它；作为 Operation 调用，审批、无人值守的短路等装饰器照常作用于它。
     */
    park: op({
      input: z.object({ schema: z.record(z.string(), z.unknown()), payload: z.unknown() }),
      impl: (ctx, input) => ctx.park(input),
    }),

    /**
     * 当前时间（毫秒）。编排代码要时间就调它，不直接用 Date.now()：
     * 调用结果记进日志，恢复重放时回送当初的值，重放走的路与原来一致。
     */
    now: op({
      input: z.null(),
      impl: async () => Date.now(),
    }),
  },
}));
