/**
 * stdlib 插件：内核机制的 Operation 形式，装配时按需装载。
 * 后续加入：exec 等。
 */

import { z } from "zod";
import { op } from "../../kernel/harness";

/**
 * 挂起：等外部经 unpark 送来一个符合 schema（JSON Schema）的值（3.5）。
 * 等人确认、等外部回调都用它；作为 Operation 调用，审批、无人值守的短路等装饰器照常作用于它。
 */
export const park = op({
  input: z.object({ schema: z.record(z.string(), z.unknown()), payload: z.unknown() }),
  impl: (ctx, input) => ctx.park(input),
});
