/**
 * 包装载（6.1）：import 插件包目录，以装配配置调它默认导出的工厂，把得到的插件对象交给 kernel.use。
 * 包名取目录名。默认导出是入口（entry.ts）时，工厂另拿一份对外接口，serve 交回给宿主。
 * 后续加入：按插件声明的 schema 校验配置；装配配置里按名字停用。
 */

import { basename, join } from "node:path";
import type { EntryDecl } from "./entry";
import type { PluginDecl } from "./plugin";
import type { Kernel } from "./kernel";

/** 装载 dir/index.ts；config 原样交给工厂。是入口时返回它的 serve，由宿主在启动完成后调 */
export async function loadPlugin(kernel: Kernel, dir: string, config: unknown = {}): Promise<(() => Promise<void>) | undefined> {
  const pkg = basename(dir);
  const mod: { default?: PluginDecl<unknown> | EntryDecl<unknown> } = await import(join(dir, "index.ts"));
  const decl = mod.default;
  if (decl?.kind === "plugin") return void kernel.use(pkg, decl.factory(config));
  if (decl?.kind !== "entry") throw new Error(`${pkg}: default export is not plugin() or entry()`);
  const object = decl.factory(config, kernel.outside(pkg));
  const { serve, ...plugin } = object;
  kernel.use(pkg, plugin);
  return () => serve.call(object);
}
