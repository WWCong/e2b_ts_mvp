/**
 * script 包的打包（7.5 的装载）：Bun 转译去掉类型、打成一个脚本，交给解释器求值。
 * - 底子：解释器里的运行时（inside/runtime.ts）连同 Zod，每个进程打一次
 * - 包：包里的模块与文本资源内联；import 的 stdlib、zod 换成取底子里的（stdlib 只有 inside/stdlib.ts 导出的那些）；
 *   别的 import（Node 内置模块、npm 包、包外的文件）打包即失败。import type 转译时就去掉了，不限
 */

import { dirname, join, relative, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";

export function bundleBase(): Promise<string> {
  return build({ entrypoints: [join(import.meta.dir, "inside", "runtime.ts")], minify: true });
}

/** 打包 dir 下的 script 包；求值后包的默认导出在 __harness.pkg */
export function bundlePackage(dir: string): Promise<string> {
  const root = resolve(dir);
  const entry = join(root, "index.ts");
  const plugin: BunPlugin = {
    name: "harness-script",
    setup(b) {
      b.onResolve({ filter: /^harness:entry$/ }, () => ({ path: "entry", namespace: "harness" }));
      b.onLoad({ filter: /.*/, namespace: "harness" }, () => ({
        contents: `import pkg from ${JSON.stringify(entry)}; globalThis.__harness.pkg = pkg;`,
        loader: "js",
      }));
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
        if (args.path.startsWith(".")) {
          const target = resolve(dirname(args.importer), args.path);
          if (target.startsWith(root + sep)) return undefined;
        }
        throw new Error(`${relative(root, args.importer)} imports ${args.path}: a script package can only import stdlib, zod and its own files`);
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
    // 打包失败是 AggregateError，原因在 errors 里
    const errors = (err as { errors?: { message: string }[] }).errors;
    throw errors ? new Error(errors.map((e) => e.message).join("\n")) : err;
  }
}
