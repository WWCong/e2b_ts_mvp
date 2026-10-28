/**
 * harness 插件：内核机制的 Operation 形式（方案里内核提供的 harness.park、harness.exec，3.5、7.5、附 A），装配时按需装载。
 */

import { z } from "zod";
import { op, plugin } from "stdlib";
import { runSource } from "../../script/sandbox";

/** 一次 harness_exec 最多发起的调用：还没有预算插件，先防一段脚本没完没了地调 */
const MAX_CALLS = 100;

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
     * 临时脚本（7.5）：一段源码在一个全新的解释器里一次跑完，跑的就是这个 Run（script 形态）：
     * 它发起的调用记在这个 Run 名下，只能调公开的，照常过装饰器、记日志、恢复时回放。
     * 能力面是公开表的全部（方案：不继承调用方的，收窄只来自脚本自己）。
     */
    exec: op({
      usage: [
        "运行一段 JavaScript/TypeScript：要连着调很多次工具、批量处理、循环或按结果分支时用它，一次做完，不用一步步来回。",
        "源码默认导出一个 async 函数 (ctx, input) => 结果：",
        '- 调工具：await ctx.call("工具名", 入参)，返回 { ok: true, value } 或 { ok: false, reason }；你的工具都能调',
        "- 返回值就是结果；console.log 的输出随结果一起交回",
        `- 在沙箱里跑：没有文件、网络、定时器、Date、Math.random，只能经工具做事；最多调 ${MAX_CALLS} 次工具`,
        '例：export default async (ctx) => { const r = await ctx.call("fs_list", { path: "." }); return r.ok ? r.value : r.reason; }',
      ].join("\n"),
      public: true,
      script: true,
      input: z.object({
        source: z.string().describe("源码：默认导出 async (ctx, input) => 结果"),
        input: z.unknown().optional().describe("交给默认导出函数的第二个参数"),
      }),
      impl: async (ctx, { source, input }) => {
        const { value, logs } = await runSource(source, input, ctx, { maxCalls: MAX_CALLS });
        return { value: value ?? null, logs };
      },
    }),
  },
}));
