/**
 * time 插件：时间。编排代码要时间就调它，不直接用 Date.now()：
 * 调用结果记进日志，恢复重放时回送当初的值，重放走的路与原来一致。
 */

import { z } from "zod";
import { op, plugin } from "stdlib";

export default plugin(() => ({
  operations: {
    /** 当前时间（毫秒） */
    now: op({
      input: z.null(),
      impl: async () => Date.now(),
    }),
  },
}));
