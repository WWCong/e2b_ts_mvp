/**
 * fs 插件：工作区里的文件原语。实现用 pi 的编码工具（read、write、edit、ls、find、grep），
 * 包成 Operation：照常过装饰器、能力面、写前日志与事件。底层文件操作换成 workspace.ts 的，工作区的边界在那里守。
 * 工作区目录取配置 workspace（缺省 ./workspace），启动时建好。
 * 写与改要人审批（ui_approval），所以依赖 ui。fs_grep 要本机装有 ripgrep（rg）：没装就以拒绝返回，
 * 不让 pi 在运行时去网上下载。
 * 后续加入：fs_delete；bash（要先做隔离）。
 */

import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditToolInput,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
} from "pi-tools";
import { z } from "zod";
import { decorator, op, plugin, type OpDecl } from "stdlib";
import { escapes, workspaceOps } from "./workspace";

/** pi 工具里我们用到的部分。ctx 是 pi 会话的上下文，这几个工具只在有它时取 cwd，我们不给 */
type PiTool = {
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: never,
  ): Promise<{ content: ({ type: "text"; text: string } | { type: "image"; mimeType: string })[] }>;
};

/** 把 pi 的工具包成 Operation：入参 schema 就是它的 JSON Schema，结果取文字部分。needs：要先在本机找到的命令 */
function wrap<I>(tool: PiTool, decorators: string[], needs?: string): OpDecl<I, string> {
  return op({
    usage: tool.description,
    public: true,
    input: z.fromJSONSchema(tool.parameters as Record<string, unknown>) as unknown as z.ZodType<I, I>,
    decorators,
    impl: async (ctx, input) => {
      if (needs && !Bun.which(needs)) throw new Error(`${needs} is not installed`);
      const result = await tool.execute(ctx.runId, input as never, ctx.signal, undefined, undefined as never);
      return result.content.map((c) => (c.type === "text" ? c.text : `[图片 ${c.mimeType}，暂不支持]`)).join("");
    },
  });
}

export default plugin((config: { workspace?: string }) => {
  const workspace = resolve(config.workspace ?? "workspace");
  const ops = workspaceOps(workspace);
  const guard = ["fs_pathGuard"];
  const approve = ["fs_pathGuard", "ui_approval"];

  return {
    requires: ["ui"],

    async onStart() {
      await mkdir(workspace, { recursive: true });
    },

    operations: {
      read: wrap<ReadToolInput>(createReadToolDefinition(workspace, { operations: ops.read }), guard),
      // 先查路径再问人：越出工作区的写不必打扰人
      write: wrap<WriteToolInput>(createWriteToolDefinition(workspace, { operations: ops.write }), approve),
      edit: wrap<EditToolInput>(createEditToolDefinition(workspace, { operations: ops.edit }), approve),
      list: wrap<LsToolInput>(createLsToolDefinition(workspace, { operations: ops.ls }), guard),
      find: wrap<FindToolInput>(createFindToolDefinition(workspace, { operations: ops.find }), guard),
      grep: wrap<GrepToolInput>(createGrepToolDefinition(workspace, { operations: ops.grep }), guard, "rg"),
    },

    decorators: {
      /**
       * 路径越出工作区就拒绝，可改了再试。早于审批：越界的写不必打扰人。
       * 与 pi 解析路径的方式对齐：去掉开头的 @；~ 开头的是家目录，一律越界。真正的边界在 workspace.ts
       */
      pathGuard: decorator({
        onError: "closed",
        fn: async (_ctx, run, next) => {
          const { path = "." } = run.input as { path?: string };
          const bare = path.replace(/^@/, "");
          if (bare.startsWith("~") || escapes(relative(workspace, resolve(workspace, bare)))) {
            return { ok: false, by: "fs_pathGuard", reason: `path escapes workspace: ${path}`, retryable: true };
          }
          return next();
        },
      }),
    },
  };
});
