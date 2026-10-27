/**
 * 包装载（6.1）：import 包目录，包名取目录名。
 * - 插件：以装配配置与它声明需要的基建调它默认导出的工厂，把得到的插件对象交给 kernel.use
 * - script 包：在解释器里求值、读出声明，交给 kernel.useScript；实现也在解释器里跑（stdlib/script）。没有配置，也不注入基建
 * 后续加入：按插件声明的 schema 校验配置；装配配置里按名字停用。
 */

import { basename, join } from "node:path";
import { grant, type Infra } from "../infra";
import { compileScript, type ScriptLimits } from "../script/sandbox";
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

/** 装载 dir/index.ts，默认导出须是 script()。包的代码不在宿主里执行；limits 给测试调小限额 */
export async function loadScript(kernel: Kernel, dir: string, limits?: ScriptLimits): Promise<void> {
  const pkg = basename(dir);
  kernel.useScript(pkg, await compileScript(pkg, dir, limits));
}
