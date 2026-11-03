/**
 * tree 插件：builder 的树。目录是「结构」（一件事，如 feat_x），根也是一个；结构里的文件是「产物」（prd.md、status.html），
 * 扩展名是 .chat 的是它的聊天（chat 插件）。点开头的不算。树在注入的工作区（Volume）上，机器把它同步到对象存储。
 */

import { z } from "zod";
import { op, opaque, plugin, type Volume } from "stdlib";

/** 树里的路径：用 / 分开的几段，每段不以点开头（相对根；根是 ""） */
export const treePath = z.string().refine((p) => p === "" || p.split("/").every((seg) => seg !== "" && !seg.startsWith(".")), "path: segments joined by /, none empty or starting with .");

/** 结构的名字：字母（含中文）、数字、_ 与 -，最长 64 */
const structureName = /^[\p{L}\p{N}_-]{1,64}$/u;

export type Structure = {
  name: string;
  /** 相对树根的路径，根是 "" */
  path: string;
  artifacts: { name: string; path: string }[];
  chats: { name: string; path: string }[];
  structures: Structure[];
};

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** 读出 dir 这个结构：产物、聊天（main 在前）、子结构，各按名字排 */
async function read(tree: Volume, dir: string): Promise<Structure> {
  const node: Structure = { name: dir.split("/").at(-1) ?? "", path: dir, artifacts: [], chats: [], structures: [] };
  for (const name of (await tree.list(dir || ".")).filter((n) => !n.startsWith(".")).sort()) {
    const path = join(dir, name);
    if ((await tree.stat(path))?.kind === "dir") node.structures.push(await read(tree, path));
    else if (name.endsWith(".chat")) node.chats.push({ name: name.slice(0, -".chat".length), path });
    else node.artifacts.push({ name, path });
  }
  node.chats.sort((a, b) => (a.name === "main" ? -1 : b.name === "main" ? 1 : a.name < b.name ? -1 : 1));
  return node;
}

export default plugin({ needs: ["workspace"] }, (_config, { workspace: tree }) => ({
  operations: {
    list: op({
      api: true,
      usage: "整棵树：从根开始，每个结构的产物、聊天与子结构",
      input: z.object({}),
      output: opaque<Structure>(),
      impl: () => read(tree, ""),
    }),

    create: op({
      api: true,
      usage: "在 parent 结构下建一个子结构 name（字母、数字、_ 与 -），返回它的路径",
      input: z.object({ parent: treePath.default(""), name: z.string().regex(structureName, "name: letters, digits, _ and -, at most 64") }),
      output: z.string(),
      impl: async (_ctx, { parent, name }) => {
        if (parent && (await tree.stat(parent))?.kind !== "dir") throw new Error(`no such structure: ${parent}`);
        const path = join(parent, name);
        if (await tree.stat(path)) throw new Error(`already exists: ${path}`);
        await tree.mkdir(path);
        return path;
      },
    }),
  },
}));
