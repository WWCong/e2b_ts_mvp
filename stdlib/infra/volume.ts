/**
 * 存储（基建）：一块按相对路径读写文件的存储，由装配配置建好、宿主管它的启停，插件只经这个接口用。
 * 放在哪由实现决定：本地目录（localDir）；以后 rclone+FUSE 挂载（open 时挂上、close 时卸下，其余同本地目录，
 * localPath 是挂载点）、对象存储（没有 localPath）等，插件不用改。
 *
 * 约定：路径相对这块存储、用 / 分隔，越不出去（.. 越界、符号链接指向外面都拒绝）；
 * 出错信息里的路径是相对的，不带出宿主机的绝对路径。
 */

import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export type Stat = { kind: "file" | "dir"; size: number; mtimeMs: number };

export interface Volume {
  /** 给人看的说明，如 dir:workspace */
  readonly name: string;
  /**
   * 本地文件系统上的目录：本地目录、FUSE 挂载点有，纯远程的没有。
   * 要同步落盘的（写前日志）与要交给外部程序的（rg，以后的 bash）用它
   */
  readonly localPath?: string;
  /** 宿主启动前调：建好目录、挂载等 */
  open(): Promise<void>;
  /** 宿主关停最后调：落盘、卸载等 */
  close(): Promise<void>;
  /** 读整个文件；给了 length 只读开头最多这么多字节（看文件头认类型用） */
  read(path: string, options?: { length?: number }): Promise<Uint8Array>;
  /** 整个替换：写到一半崩溃不留半截；父目录自动建 */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** 不存在返回 undefined */
  stat(path: string): Promise<Stat | undefined>;
  /** 目录里的名字 */
  list(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  /** 在 dir（缺省根）下按 glob 找文件，返回相对 dir 的路径；ignore 里的 glob 跳过，最多 limit 个 */
  glob(pattern: string, options?: { dir?: string; ignore?: string[]; limit?: number }): Promise<string[]>;
  /** 其中一个子目录，当作一块独立的存储：越不出它（宿主据此给每个插件分一块 store） */
  sub(path: string): Volume;
}

/** 相对路径是否越出了它的基准目录 */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** 本地目录（也适用于已经挂好的 FUSE、NFS 目录）。open 时建好 */
export function localDir(root: string): Volume {
  const base = resolve(root);

  /** 相对路径 → 绝对路径：按字面查一次，再沿已存在的部分解开符号链接查一次（根自己还不存在也行） */
  async function locate(path: string): Promise<string> {
    const normal = posix.normalize(path);
    if (posix.isAbsolute(normal) || escapes(normal)) throw new Error(`path escapes the volume: ${path}`);
    const abs = join(base, normal);
    if (escapes(relative(await real(base), await real(abs)))) throw new Error(`path escapes the volume via symlink: ${path}`);
    return abs;
  }

  /** 先找到位置再做；文件系统的错误换成相对路径的说法 */
  const at =
    <A extends unknown[], R>(fn: (abs: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      const abs = await locate(path);
      try {
        return await fn(abs, ...rest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw code ? new Error(`${code}: ${relative(base, abs) || "."}`) : err;
      }
    };

  return {
    name: `dir:${root}`,
    localPath: base,
    open: async () => void (await mkdir(base, { recursive: true })),
    close: async () => {},
    read: at(async (abs, { length }: { length?: number } = {}) => {
      if (length === undefined) return readFile(abs);
      const file = await open(abs, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    }),
    write: at(async (abs, data: string | Uint8Array) => {
      await mkdir(dirname(abs), { recursive: true });
      // 先写临时文件再改名：同一目录里的 rename 是原子的
      const tmp = `${abs}.tmp-${crypto.randomUUID().slice(0, 8)}`;
      await writeFile(tmp, data);
      await rename(tmp, abs);
    }),
    stat: at(async (abs) => {
      try {
        const s = await stat(abs);
        return { kind: s.isDirectory() ? "dir" : "file", size: s.size, mtimeMs: s.mtimeMs } as Stat;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    }),
    list: at((abs) => readdir(abs)),
    mkdir: at(async (abs) => void (await mkdir(abs, { recursive: true }))),
    glob: async (pattern, { dir = ".", ignore = [], limit = Infinity } = {}) => {
      const cwd = await locate(dir);
      const skip = ignore.map((p) => new Bun.Glob(p));
      const found: string[] = [];
      for await (const path of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
        if (skip.some((g) => g.match(path))) continue;
        found.push(path);
        if (found.length >= limit) break;
      }
      return found;
    },
    sub: (path) => {
      const normal = posix.normalize(path);
      if (posix.isAbsolute(normal) || escapes(normal)) throw new Error(`path escapes the volume: ${path}`);
      return localDir(join(base, normal));
    },
  };
}

/** 解开符号链接后的路径：已存在的部分取 realpath，其余原样接上 */
async function real(path: string): Promise<string> {
  let probe = path;
  while (!(await exists(probe))) probe = dirname(probe);
  return join(await realpath(probe), relative(probe, path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
