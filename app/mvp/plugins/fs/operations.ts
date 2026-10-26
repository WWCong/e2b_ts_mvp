/**
 * pi 工具的底层文件操作，落到注入的工作区（Volume）上。pi 给的是按工具的根解析出的绝对路径，
 * 这里换回相对路径交给工作区；越出根的一律拒绝。边界、符号链接的检查在 Volume 的实现里。
 */

import { posix } from "node:path";
import type { Volume } from "stdlib";

/** 相对路径是否越出了它的基准目录 */
export function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel);
}

/** root：交给 pi 工具的根（它据此把入参里的路径解析成绝对路径） */
export function operations(workspace: Volume, root: string) {
  const rel = (abs: string) => {
    const path = posix.relative(root, abs);
    if (escapes(path)) throw new Error(`path escapes workspace: ${path}`);
    return path || ".";
  };
  const stat = async (abs: string) => {
    const s = await workspace.stat(rel(abs));
    if (!s) throw new Error(`ENOENT: ${rel(abs)}`);
    return s;
  };
  const readFile = async (abs: string) => Buffer.from(await workspace.read(rel(abs)));
  const writeFile = (abs: string, content: string) => workspace.write(rel(abs), content);
  const exists = async (abs: string) => (await workspace.stat(rel(abs))) !== undefined;
  const access = async (abs: string) => void (await stat(abs));

  return {
    read: { readFile, access },
    write: { writeFile, mkdir: (abs: string) => workspace.mkdir(rel(abs)) },
    edit: { readFile, writeFile, access },
    ls: {
      exists,
      stat: async (abs: string) => {
        const { kind } = await stat(abs);
        return { isDirectory: () => kind === "dir" };
      },
      readdir: (abs: string) => workspace.list(rel(abs)),
    },
    find: {
      exists,
      glob: (pattern: string, cwd: string, { ignore, limit }: { ignore: string[]; limit: number }) =>
        workspace.glob(pattern, { dir: rel(cwd), ignore, limit }),
    },
    grep: {
      isDirectory: async (abs: string) => (await stat(abs)).kind === "dir",
      readFile: async (abs: string) => new TextDecoder().decode(await workspace.read(rel(abs))),
    },
  };
}
