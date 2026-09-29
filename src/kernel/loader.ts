/**
 * 包装载：把一个插件包目录的导出注册进内核（6.1）。
 * 导出只能是 op() 或 decorator() 的声明，名字取「包名_导出名」，须合命名规则（names.ts）。
 * 后续加入：setup(config)、@on 处理器、装配配置里按名字停用。
 */

import { basename, join } from "node:path";
import type { DecoratorDecl, OpDecl } from "./harness";
import type { Kernel } from "./kernel";
import { checkName, checkPackageName } from "./names";

/** 装载 dir/index.ts；包名取目录名 */
export async function loadPlugin(kernel: Kernel, dir: string): Promise<void> {
  const pkg = basename(dir);
  checkPackageName(pkg);
  const mod: Record<string, unknown> = await import(join(dir, "index.ts"));

  for (const [exp, value] of Object.entries(mod)) {
    const name = `${pkg}_${exp}`;
    checkName(name);
    const kind = (value as { kind?: unknown } | null)?.kind;
    if (kind === "operation") {
      const { kind: _, ...decl } = value as OpDecl;
      kernel.register({ name, ...decl });
    } else if (kind === "decorator") {
      const { kind: _, ...decl } = value as DecoratorDecl;
      kernel.registerDecorator({ id: name, ...decl });
    } else {
      throw new Error(`${pkg}: export ${exp} is neither op() nor decorator()`);
    }
  }
}
