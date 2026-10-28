/**
 * script 的打包（7.5 的装载）：Bun 转译去掉类型、打成一个脚本，交给解释器求值。
 * - 底子：解释器里的运行时（inside/runtime.ts）连同 Zod，每个进程打一次
 * - 包：包里的模块与文本资源内联；import 的 stdlib、zod 换成取底子里的（stdlib 只有 inside/stdlib.ts 导出的那些）；
 *   别的 import（Node 内置模块、npm 包、包外的文件）打包即失败。import type 转译时就去掉了，不限。
 *   包里的文件按解开符号链接后的真实路径查，指到包外的也算包外（工作区里的草稿可能是模型写的）
 * - 一段源码（harness_exec）：同上，只是没有包目录，只能 import stdlib 与 zod
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";

export function bundleBase(): Promise<string> {
  return build({ entrypoints: [join(import.meta.dir, "inside", "runtime.ts")], minify: true });
}

/** 打包 dir 下的 script 包；求值后包的默认导出在 __harness.pkg */
export function bundlePackage(dir: string): Promise<string> {
  const root = resolve(dir);
  return bundle(join(root, "index.ts"), root);
}

/** 打包一段源码（TypeScript 或 JavaScript）；求值后它的默认导出在 __harness.pkg */
export function bundleSource(source: string): Promise<string> {
  return bundle("harness:source", undefined, source);
}

/** entry 是入口模块；root 是包目录，包里的文件可以互相 import；source 是没有文件的入口的源码 */
async function bundle(entry: string, root?: string, source?: string): Promise<string> {
  const rule = root ? "a script package can only import stdlib, zod and its own files" : "a script can only import stdlib and zod";
  const inside = root && realpathSync(root) + sep;
  /** 包里的一个模块：试常见的扩展名与 index；返回真实路径，指到包外的返回 null，没有返回 undefined */
  const locate = (target: string): string | null | undefined => {
    for (const candidate of [target, ...[".ts", ".tsx", ".js", ".json"].map((ext) => target + ext), join(target, "index.ts"), join(target, "index.js")]) {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const real = realpathSync(candidate);
      return inside && real.startsWith(inside) ? real : null;
    }
    return undefined;
  };
  if (root) {
    const main = locate(entry);
    if (!main) throw new Error(main === null ? "index.ts points outside the package" : "no index.ts");
  }
  const plugin: BunPlugin = {
    name: "harness-script",
    setup(b) {
      b.onResolve({ filter: /^harness:(entry|source)$/ }, (args) => ({ path: args.path.slice("harness:".length), namespace: "harness" }));
      b.onLoad({ filter: /^entry$/, namespace: "harness" }, () => ({
        contents: `import pkg from ${JSON.stringify(entry)}; globalThis.__harness.pkg = pkg;`,
        loader: "js",
      }));
      b.onLoad({ filter: /^source$/, namespace: "harness" }, () => ({ contents: source ?? "", loader: "ts" }));
      b.onResolve({ filter: /^(stdlib|zod)$/ }, (args) => ({ path: args.path, namespace: "harness-base" }));
      // stdlib 逐个列出导出：import 了没有的（plugin、host…）打包时就报错；zod 整个给
      b.onLoad({ filter: /^stdlib$/, namespace: "harness-base" }, async () => ({
        contents: `export const { ${Object.keys(await import("./inside/stdlib")).join(", ")} } = globalThis.__harness.modules.stdlib;`,
        loader: "js",
      }));
      b.onLoad({ filter: /^zod$/, namespace: "harness-base" }, () => ({
        contents: "module.exports = globalThis.__harness.modules.zod;",
        loader: "js",
      }));
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === entry) return undefined;
        const from = root ? relative(root, args.importer) : "source";
        if (root && args.path.startsWith(".")) {
          const found = locate(resolve(dirname(args.importer), args.path));
          if (found) return { path: found };
          if (found === undefined) throw new Error(`${from} imports ${args.path}: no such file`);
        }
        throw new Error(`${from} imports ${args.path}: ${rule}`);
      });
    },
  };
  return build({ entrypoints: ["harness:entry"], plugins: [plugin] });
}

async function build(options: { entrypoints: string[]; plugins?: BunPlugin[]; minify?: boolean }): Promise<string> {
  try {
    const result = await Bun.build({ ...options, target: "browser", format: "esm" });
    return await result.outputs[0]!.text();
  } catch (err) {
    // 打包失败是 AggregateError，原因在 errors 里；源码写错的带上行列
    const errors = (err as { errors?: { message: string; position?: { line: number; column: number } | null }[] }).errors;
    if (!errors) throw err;
    throw new Error(errors.map((e) => (e.position?.line ? `${e.position.line}:${e.position.column} ${e.message}` : e.message)).join("\n"));
  }
}
