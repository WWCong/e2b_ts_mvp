/**
 * 包装载：把一个插件包目录的导出函数注册进内核（6.1）。
 * 导出函数即 Operation，名为「包名.函数名」；带 @decorator 的是装饰器，id 同样是「包名.函数名」。
 * 后续加入：@public、@only / @exclude（4b）、@limits、usage、@on 处理器、setup(config)、
 * 导出签名校验（7.4），以及构建期生成 d.ts 与 schema（届时标签改由构建期提取）。
 */

import { basename, join } from "node:path";
import type { Decorator, OnError } from "./chain";
import type { Kernel, OperationImpl } from "./kernel";

/** 装载 dir/index.ts；包名取目录名 */
export async function loadPlugin(kernel: Kernel, dir: string): Promise<void> {
  const pkg = basename(dir);
  const entry = join(dir, "index.ts");
  const mod: Record<string, unknown> = await import(entry);
  const docs = scanTags(await Bun.file(entry).text());

  for (const [fn, value] of Object.entries(mod)) {
    if (typeof value !== "function") throw new Error(`${pkg}: export ${fn} is not a function`);
    const name = `${pkg}.${fn}`;
    const tags = docs.get(fn) ?? new Map<string, string>();
    if (tags.has("decorator")) {
      kernel.registerDecorator({ id: name, onError: parseOnError(name, tags.get("onError")), fn: value as Decorator });
    } else {
      kernel.register({ name, impl: value as OperationImpl, decorators: splitList(tags.get("decorators")) });
    }
  }
}

/**
 * 函数名 → 标签（标签名 → 标签后的文本）。
 * 只认紧挨在 `export [async] function 名字` 之前的 JSDoc；标签须在行首，每行一个。
 */
export function scanTags(source: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  // 注释体里不含 */，保证只取紧挨着函数的那一段
  const decl = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export\s+(?:async\s+)?function\s+(\w+)/g;
  for (const [, body = "", fn = ""] of source.matchAll(decl)) {
    const tags = new Map<string, string>();
    for (const [, tag = "", value = ""] of body.matchAll(/^\s*\*?\s*@(\w+)(.*)$/gm)) tags.set(tag, value.trim());
    result.set(fn, tags);
  }
  return result;
}

/** 缺省 closed：管控类出错必须中断 */
function parseOnError(name: string, value: string | undefined): OnError {
  if (value === undefined || value === "closed") return "closed";
  if (value === "open") return "open";
  throw new Error(`${name}: invalid @onError ${value}`);
}

/** 「a, b」或「a b」 */
function splitList(value: string | undefined): string[] {
  return value ? value.split(/[\s,]+/).filter(Boolean) : [];
}
