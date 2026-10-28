/**
 * 装上的 script 包：持久状态的 scripts/ 下，每个包一个目录。宿主建它，把其中的 scripts 交给声明需要的插件（见 stdlib/infra）。
 * - 启动时在装配的 script 包之后装载（loadAll）；装不上的跳过，打在标准错误上，不挡启动
 * - 运行中经 install 装上或换掉：先把文件拷到临时目录、在解释器里装载一遍，过了才换到 scripts/<包名>/，
 *   再换进内核；内核不收就把盘上的换回去
 * 名字不能与装配里的包（插件、装配的 script 包）重：要改它们改装配
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Scripts, Volume } from "../infra";
import type { Kernel } from "../kernel/kernel";
import { loadScript } from "../kernel/loader";
import { checkPackageName } from "../kernel/names";
import { compileScript } from "./sandbox";

/** 一个包最多拷这么多文件、这么多字节：草稿目录里不该有大东西 */
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

/** root：装上的包所在的本地目录；reserved：装配里的包名 */
export function installedScripts(kernel: Kernel, root: string, reserved: ReadonlySet<string>) {
  const install = async (pkg: string, from: Volume): Promise<string[]> => {
    checkPackageName(pkg);
    if (reserved.has(pkg)) throw new Error(`${pkg} is part of the assembly: change it there`);
    await mkdir(root, { recursive: true });
    const id = crypto.randomUUID().slice(0, 8);
    const [fresh, backup, target] = [join(root, `.new-${pkg}-${id}`), join(root, `.old-${pkg}-${id}`), join(root, pkg)];
    try {
      await copy(from, fresh);
      const script = await compileScript(pkg, fresh);
      const had = existsSync(target);
      if (had) await rename(target, backup);
      await rename(fresh, target);
      try {
        kernel.installScript(pkg, script);
      } catch (err) {
        await rm(target, { recursive: true, force: true });
        if (had) await rename(backup, target);
        throw err;
      }
      if (had) await rm(backup, { recursive: true, force: true });
      return Object.keys(script.operations).map((key) => `${pkg}_${key}`);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  };

  return {
    scripts: { install } satisfies Scripts,

    /** 启动时装载 root 下的每个包（kernel.boot 之前） */
    async loadAll(): Promise<void> {
      if (!existsSync(root)) return;
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skip = (why: string) => console.error(`harness：装上的 script 包 ${entry.name} 没有装载：${why}`);
        if (reserved.has(entry.name)) {
          skip("与装配里的包同名");
          continue;
        }
        try {
          await loadScript(kernel, join(root, entry.name));
        } catch (err) {
          skip(err instanceof Error ? err.message : String(err));
        }
      }
    },
  };
}

/** 把 from 里的文件（不含点开头的）拷到本地目录 to */
async function copy(from: Volume, to: string): Promise<void> {
  const files = await from.glob("**/*", { limit: MAX_FILES + 1 });
  if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files in the package`);
  let bytes = 0;
  for (const path of files) {
    const data = await from.read(path);
    bytes += data.byteLength;
    if (bytes > MAX_BYTES) throw new Error(`the package is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    await Bun.write(join(to, path), data);
  }
}
