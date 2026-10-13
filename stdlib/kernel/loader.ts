/**
 * 包装载（6.1）：import 插件包目录，以装配配置调它默认导出的工厂，把得到的插件对象交给 kernel.use。
 * 包名取目录名。后续加入：按插件声明的 schema 校验配置；装配配置里按名字停用。
 */

import { basename, join } from "node:path";
import type { PluginDecl } from "./plugin";
import type { Kernel } from "./kernel";

/** 装载 dir/index.ts；config 原样交给插件的工厂 */
export async function loadPlugin(kernel: Kernel, dir: string, config: unknown = {}): Promise<void> {
  const pkg = basename(dir);
  const mod: { default?: PluginDecl<unknown> } = await import(join(dir, "index.ts"));
  if (mod.default?.kind !== "plugin") throw new Error(`${pkg}: default export is not plugin()`);
  kernel.use(pkg, mod.default.factory(config));
}
