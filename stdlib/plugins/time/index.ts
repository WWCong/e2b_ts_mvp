/**
 * time 插件：时间。编排代码要时间就调它，不直接用 Date.now()：
 * 调用结果记进日志，恢复重放时回送当初的值，重放走的路与原来一致。
 * 公开（script 包能调），不交给模型当工具。方案里 script 的 Date.now() 由解释器提供、随调用记录回放（7.5），
 * 在那之前 script 包经它取时间。
 */

import { z } from "zod";
import { op, plugin } from "stdlib";

export default plugin(() => ({
  operations: {
    now: op({
      usage: "当前时间：Unix 时间戳（毫秒）",
      public: true,
      tool: false,
      input: z.null(),
      impl: async () => Date.now(),
    }),
  },
}));
