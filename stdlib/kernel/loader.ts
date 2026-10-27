/**
 * 包装载（6.1）：import 插件包目录，以装配配置与它声明需要的基建调它默认导出的工厂，把得到的插件对象交给 kernel.use。
 * 包名取目录名。
 * 后续加入：按插件声明的 schema 校验配置；装配配置里按名字停用。
 */

import { basename, join } from "node:path";
import { grant, type Infra } from "../infra";
import type { PluginDecl } from "./plugin";
import type { Kernel } from "./kernel";

/** 装载 dir/index.ts；config 原样交给工厂，infra 里按插件的 needs 取 */
export async function loadPlugin(kernel: Kernel, dir: string, config: unknown = {}, infra: Infra = {}): Promise<void> {
  const pkg = basename(dir);
  const mod: { default?: PluginDecl<unknown> } = await import(join(dir, "index.ts"));
  const decl = mod.default;
  if (decl?.kind !== "plugin") throw new Error(`${pkg}: default export is not plugin()`);
  kernel.use(pkg, decl.factory(config, grant(pkg, decl.needs, infra)));
}
