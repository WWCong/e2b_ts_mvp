/**
 * fs 插件：工作区里的文件原语。实现用 pi 的编码工具（read、write、edit、ls、find、grep），
 * 包成 Operation：照常过装饰器、能力面、写前日志与事件。工作区是注入的基建（Volume），
 * 本地目录还是挂载的远程存储由装配配置决定；底层文件操作经 operations.ts 落到它上面，边界在它的实现里守。
 * 交给 pi 的根是虚拟的 /workspace：模型看到的路径不带宿主机的目录。fs_grep 要调 ripgrep（rg）扫真实文件，
 * 所以要工作区有本地路径（本地目录、FUSE 挂载点），也要本机装有 rg；不满足就以拒绝返回，不让 pi 在运行时去网上下载。
 * 写与改要人审批（ui_approval），所以依赖 ui。
 * 后续加入：fs_delete；bash（要先做隔离，也要本地路径）。
 */

import { posix } from "node:path";
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
import { escapes, operations } from "./operations";

/** 交给 pi 工具的根：虚拟的，模型看到的绝对路径都在它下面 */
const ROOT = "/workspace";

/** 入参里的路径换成相对工作区的（与 pi 解析路径的方式对齐：去掉开头的 @，~ 开头的是家目录）；越界返回 undefined */
function inside(path: string): string | undefined {
  const bare = path.replace(/^@/, "");
  if (bare.startsWith("~")) return undefined;
  const rel = posix.relative(ROOT, posix.resolve(ROOT, bare));
  return escapes(rel) ? undefined : rel || ".";
}

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

/**
 * 把 pi 的工具包成 Operation：入参 schema 就是它的 JSON Schema，结果取文字部分。
 * 入参里的路径先换成相对工作区的（fs_pathGuard 已拒掉越界的），各工具再按自己的根解析。
 * unavailable：这个工具现在用不了的原因（缺本地路径、缺命令），调用时以拒绝返回
 */
function wrap<I>(tool: PiTool, decorators: string[], unavailable?: () => string | undefined): OpDecl<I, string> {
  return op({
    usage: tool.description,
    public: true,
    input: z.fromJSONSchema(tool.parameters as Record<string, unknown>) as unknown as z.ZodType<I, I>,
    decorators,
    impl: async (ctx, input) => {
      const why = unavailable?.();
      if (why) throw new Error(why);
      const { path } = input as { path?: string };
      const params = path === undefined ? input : { ...input, path: inside(path) ?? path };
      const result = await tool.execute(ctx.runId, params as never, ctx.signal, undefined, undefined as never);
      return result.content.map((c) => (c.type === "text" ? c.text : `[图片 ${c.mimeType}，暂不支持]`)).join("");
    },
  });
}

export default plugin({ needs: ["workspace"] }, (_config, { workspace }) => {
  const ops = operations(workspace, ROOT);
  // rg 扫的是真实文件：根是工作区的本地路径，相对路径照常解析
  const local = workspace.localPath;
  const grepOps = operations(workspace, local ?? ROOT).grep;
  const grepUnavailable = () =>
    !local ? `fs_grep needs the workspace on a local path, ${workspace.name} has none` : !Bun.which("rg") ? "rg is not installed" : undefined;
  const guard = ["fs_pathGuard"];
  const approve = ["fs_pathGuard", "ui_approval"];

  return {
    requires: ["ui"],

    operations: {
      read: wrap<ReadToolInput>(createReadToolDefinition(ROOT, { operations: ops.read }), guard),
      // 先查路径再问人：越出工作区的写不必打扰人
      write: wrap<WriteToolInput>(createWriteToolDefinition(ROOT, { operations: ops.write }), approve),
      edit: wrap<EditToolInput>(createEditToolDefinition(ROOT, { operations: ops.edit }), approve),
      list: wrap<LsToolInput>(createLsToolDefinition(ROOT, { operations: ops.ls }), guard),
      find: wrap<FindToolInput>(createFindToolDefinition(ROOT, { operations: ops.find }), guard),
      grep: wrap<GrepToolInput>(createGrepToolDefinition(local ?? ROOT, { operations: grepOps }), guard, grepUnavailable),
    },

    decorators: {
      /**
       * 路径越出工作区就拒绝，可改了再试。早于审批：越界的写不必打扰人。
       * 与 pi 解析路径的方式对齐：去掉开头的 @；~ 开头的是家目录，一律越界。真正的边界在工作区（Volume）的实现里
       */
      pathGuard: decorator({
        onError: "closed",
        fn: async (_ctx, run, next) => {
          const { path = "." } = run.input as { path?: string };
          if (inside(path) === undefined) {
            return { ok: false, by: "fs_pathGuard", reason: `path escapes workspace: ${path}`, retryable: true };
          }
          return next();
        },
      }),
    },
  };
});
