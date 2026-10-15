/**
 * 工作区的文件操作，交给 pi 的工具当底层（各工具的 operations）。工作区的边界在这一层守：
 * 工具怎么解析路径（~ 展开、去掉开头的 @ 等）都不要紧，落到这里的每个绝对路径都先查
 * ——按字面在不在工作区里，再沿已存在的部分解开符号链接查一次。
 * 出错信息里的路径一律换成相对工作区的，不把宿主机的绝对路径交给模型。
 */

import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

/** 相对路径是否越出了它的基准目录 */
export function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function workspaceOps(root: string) {
  let realRoot: string | undefined;
  const rel = (path: string) => relative(root, path) || ".";

  /** 路径在工作区里才放行；越界抛异常 */
  async function contain(path: string): Promise<void> {
    if (escapes(relative(root, path))) throw new Error(`path escapes workspace: ${rel(path)}`);
    realRoot ??= await realpath(root);
    let probe = path;
    while (!(await exists(probe))) probe = dirname(probe);
    if (escapes(relative(realRoot, await realpath(probe)))) throw new Error(`path escapes workspace via symlink: ${rel(path)}`);
  }

  /** 先查边界再做；文件系统的错误换成相对路径的说法 */
  const guarded =
    <A extends unknown[], R>(fn: (path: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      await contain(path);
      try {
        return await fn(path, ...rest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw code ? new Error(`${code}: ${rel(path)}`) : err;
      }
    };

  const read = guarded((path) => readFile(path));
  const readText = guarded((path) => readFile(path, "utf8"));
  const write = guarded((path, content: string) => writeFile(path, content));
  const isDirectory = guarded(async (path) => (await stat(path)).isDirectory());
  const globIn = guarded(async (cwd, pattern: string, options: { ignore: string[]; limit: number }) => {
    const ignore = options.ignore.map((p) => new Bun.Glob(p));
    const found: string[] = [];
    for await (const path of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
      if (ignore.some((g) => g.match(path))) continue;
      found.push(path);
      if (found.length >= options.limit) break;
    }
    return found;
  });

  return {
    read: { readFile: read, access: guarded((path) => access(path, constants.R_OK)) },
    write: { writeFile: write, mkdir: guarded(async (path) => void (await mkdir(path, { recursive: true }))) },
    edit: { readFile: read, writeFile: write, access: guarded((path) => access(path, constants.R_OK | constants.W_OK)) },
    ls: {
      exists: guarded(exists),
      stat: guarded((path) => stat(path)),
      readdir: guarded((path) => readdir(path)),
    },
    /** 用 Bun 的 glob，不用 fd：缺了 fd 时 pi 会在运行时去网上下载 */
    find: {
      exists: guarded(exists),
      glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => globIn(cwd, pattern, options),
    },
    grep: { isDirectory, readFile: readText },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
