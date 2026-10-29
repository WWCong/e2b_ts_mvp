/**
 * fs 插件（沙盒应用的）：工作区里的文件原语，管理 agent 用它写处理接口的草稿。实现用 pi 的编码工具
 * （read、write、edit、ls、find、grep），包成 Operation：照常过装饰器、能力面、写前日志与事件。
 * 与 MVP 的不同：写与改不问人。工作区里只是草稿，把关在装上与对外（package_install 等）。
 * 工作区是注入的基建（Volume），底层文件操作经 operations.ts 落到它上面，边界在它的实现里守：越出工作区的路径以拒绝返回。
 * 交给 pi 的根是虚拟的 /workspace：模型看到的路径不带宿主机的目录。fs_grep 要调 ripgrep（rg）扫真实文件，
 * 所以要工作区有本地路径，也要本机装有 rg；不满足就以拒绝返回，不让 pi 在运行时去网上下载。
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
import { op, plugin, type ContentBlock, type OpDecl, type ToolContent } from "stdlib";
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
  ): Promise<{ content: ContentBlock[] }>;
};

/**
 * 把 pi 的工具包成 Operation：入参 schema 就是它的 JSON Schema。结果只有文字时是字符串；
 * 带图片时（fs_read 读到图片）是 ToolContent。越出工作区的路径拒绝，可改了再试。
 * unavailable：这个工具现在用不了的原因（缺本地路径、缺命令），调用时以拒绝返回
 */
function wrap<I, O extends string | ToolContent = string>(tool: PiTool, unavailable?: () => string | undefined): OpDecl<I, O> {
  return op({
    usage: tool.description,
    public: true,
    input: z.fromJSONSchema(tool.parameters as Record<string, unknown>) as unknown as z.ZodType<I, I>,
    impl: async (ctx, input) => {
      const why = unavailable?.();
      if (why) throw new Error(why);
      const { path } = input as { path?: string };
      const rel = path === undefined ? undefined : inside(path);
      if (path !== undefined && rel === undefined) throw new Error(`path escapes workspace: ${path}`);
      const params = rel === undefined ? input : { ...input, path: rel };
      const result = await tool.execute(ctx.runId, params as never, ctx.signal, undefined, undefined as never);
      if (result.content.some((c) => c.type === "image")) return { content: result.content } as O;
      return result.content.map((c) => (c.type === "text" ? c.text : "")).join("") as O;
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

  return {
    operations: {
      // 只有 read 会带图片
      read: wrap<ReadToolInput, string | ToolContent>(createReadToolDefinition(ROOT, { operations: ops.read })),
      write: wrap<WriteToolInput>(createWriteToolDefinition(ROOT, { operations: ops.write })),
      edit: wrap<EditToolInput>(createEditToolDefinition(ROOT, { operations: ops.edit })),
      list: wrap<LsToolInput>(createLsToolDefinition(ROOT, { operations: ops.ls })),
      find: wrap<FindToolInput>(createFindToolDefinition(ROOT, { operations: ops.find })),
      grep: wrap<GrepToolInput>(createGrepToolDefinition(local ?? ROOT, { operations: grepOps }), grepUnavailable),
    },
  };
});
