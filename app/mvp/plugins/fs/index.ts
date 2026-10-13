/**
 * fs 插件：工作区里的文件原语。工作区目录取配置 workspace（缺省 ./workspace），启动时建好。
 * 写文件要人审批（ui_approval），所以装 fs 时也要装 ui，与 stdlib 的 harness 插件。
 * 后续加入：fs_delete。
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { decorator, op, plugin } from "stdlib";

const relPath = z.string().describe("工作区内的相对路径");

export default plugin((config: { workspace?: string }) => {
  const workspace = resolve(config.workspace ?? "workspace");
  const inWorkspace = (path: string) => resolve(workspace, path);

  return {
    async onStart() {
      await mkdir(workspace, { recursive: true });
    },

    operations: {
      read: op({
        usage: "读取工作区里一个文本文件的全部内容",
        public: true,
        input: z.object({ path: relPath }),
        decorators: ["fs_pathGuard"],
        impl: (ctx, input) => readFile(inWorkspace(input.path), { encoding: "utf8", signal: ctx.signal }),
      }),

      write: op({
        usage: "把内容写入工作区里的文件：文件已存在则覆盖，目录不存在则自动创建",
        public: true,
        input: z.object({ path: relPath, content: z.string().describe("要写入的完整内容") }),
        // 先查路径再问人：越出工作区的写不必打扰人
        decorators: ["fs_pathGuard", "ui_approval"],
        impl: async (ctx, input) => {
          const file = inWorkspace(input.path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, input.content, { signal: ctx.signal });
          return { written: input.path, bytes: Buffer.byteLength(input.content) };
        },
      }),

      list: op({
        usage: "列出工作区里一个目录下的文件与子目录",
        public: true,
        input: z.object({ path: relPath.default(".") }),
        decorators: ["fs_pathGuard"],
        impl: async (_ctx, input) => {
          const entries = await readdir(inWorkspace(input.path), { withFileTypes: true });
          // 按字符码排序（不用 localeCompare，它随环境的 locale 变）：结果逐字节稳定，进模型历史时不破坏前缀缓存
          return entries
            .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }))
            .sort((a, b) => (a.name < b.name ? -1 : 1));
        },
      }),
    },

    decorators: {
      /** 路径越出工作区就拒绝；按字面判断，不跟随符号链接 */
      pathGuard: decorator({
        onError: "closed",
        fn: async (_ctx, run, next) => {
          const { path } = run.input as { path: string };
          const rel = relative(workspace, inWorkspace(path));
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            return { ok: false, by: "fs_pathGuard", reason: `path escapes workspace: ${path}`, retryable: true };
          }
          return next();
        },
      }),
    },
  };
});
