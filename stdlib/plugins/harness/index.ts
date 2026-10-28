/**
 * harness 插件：内核机制的 Operation 形式（方案里内核提供的 harness.park、harness.exec，3.5、7.5、附 A），装配时按需装载。
 * 有工作区就用（wants）：harness_exec 跑工作区里的 script 包草稿；没有工作区时只能跑源码。
 */

import { join } from "node:path";
import { z } from "zod";
import { op, plugin } from "stdlib";
import { runDraft, runSource } from "../../script/sandbox";

/** 一次 harness_exec 最多发起的调用：还没有预算插件，先防一段脚本没完没了地调 */
const MAX_CALLS = 100;

export default plugin({ wants: ["workspace"] }, (_config, { workspace }) => ({
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
     * 临时脚本（7.5）：一段源码，或工作区里一个 script 包草稿的 Operation，在一个全新的解释器里一次跑完，
     * 跑的就是这个 Run（script 形态）：它发起的调用记在这个 Run 名下，只能调公开的，照常过装饰器、记日志、恢复时回放。
     * 能力面是公开表的全部（方案：不继承调用方的，收窄只来自脚本自己）。
     */
    exec: op({
      usage: [
        "运行一段 JavaScript/TypeScript：要连着调很多次工具、批量处理、循环或按结果分支时用它，一次做完，不用一步步来回。",
        "源码默认导出一个 async 函数 (ctx, input) => 结果：",
        '- 调工具：await ctx.call("工具名", 入参)，返回 { ok: true, value } 或 { ok: false, reason }；你的工具都能调',
        "- 返回值就是结果，要看的数据请 return；console.log 只记进 Harness 的日志，不交回给你",
        `- 在沙箱里跑：没有文件、网络、定时器、Date、Math.random，只能经工具做事；最多调 ${MAX_CALLS} 次工具`,
        '例：export default async (ctx) => { const r = await ctx.call("fs_list", { path: "." }); return r.ok ? r.value : r.reason; }',
        "也可以试跑工作区里的 script 包草稿：给 dir（包目录）与 operation（要跑的键名），不给 source。包里的文件可以互相 import，index.ts 这样写：",
        'import { z } from "zod"; import { op, script } from "stdlib"; export default script({ operations: { 键名: op({ usage: "说明", input: z.object({ … }), impl: async (ctx, input) => 结果 }) } });',
      ].join("\n"),
      public: true,
      script: true,
      input: z.object({
        source: z.string().optional().describe("源码：默认导出 async (ctx, input) => 结果"),
        dir: z.string().optional().describe("或者：工作区里 script 包草稿的目录"),
        operation: z.string().optional().describe("跑草稿里的哪个 Operation（operations 的键名）"),
        input: z.unknown().optional().describe("交给它的入参"),
      }),
      impl: async (ctx, { source, dir, operation, input }) => {
        const limits = { maxCalls: MAX_CALLS };
        if (source !== undefined && dir === undefined) return (await runSource(source, input, ctx, limits)) ?? null;
        if (source !== undefined || dir === undefined || operation === undefined) throw new Error("give either source, or dir and operation");
        if (!workspace) throw new Error("no workspace: running a draft needs one");
        // 越出工作区的（含指向外面的符号链接）在这里就拒绝；打包要读真实文件，工作区须在本地
        if ((await workspace.stat(join(dir, "index.ts")))?.kind !== "file") throw new Error(`no ${join(dir, "index.ts")} in the workspace`);
        const local = workspace.sub(dir).localPath;
        if (!local) throw new Error("the workspace has no local path: running a draft needs one");
        return (await runDraft(local, operation, input, ctx, limits)) ?? null;
      },
    }),
  },
}));
