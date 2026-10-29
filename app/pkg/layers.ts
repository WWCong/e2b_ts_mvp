/**
 * 分层的约束：应用的插件只经注入的基建做 IO（stdlib/infra）——不直接 import 文件、网络、子进程，
 * 不在运行时用模型 SDK（import type 可以，消息格式用它的），不读环境变量、不直接 fetch。
 * 插件与内核在同一个进程里，挡不住 import，所以各应用在测试里用它查自己的插件。
 * 例外：pi-tools（pi 的编码工具）照常 import，它的文件操作换成了注入的（如 fs 插件的 operations.ts）。
 * script 包（应用层）不用查：打包时只许 import stdlib、zod 与包里的文件，在解释器里跑，碰不到宿主（stdlib/script）。
 */

import { join, relative } from "node:path";

const MODULES = ["fs", "fs/promises", "child_process", "net", "http", "https", "dgram", "worker_threads"];
const RUNTIME_ONLY = ["@earendil-works/pi-ai"];
const GLOBALS = [/\bBun\.(file|write|spawn|spawnSync|connect|listen|serve)\b/, /\bfetch\(/, /\bprocess\.env\b/];

/** 一个源文件违反了哪些约束 */
export function violations(source: string): string[] {
  const found: string[] = [];
  for (const [, typeOnly, from] of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
    const bare = from!.replace(/^node:/, "");
    if (MODULES.includes(bare)) found.push(`imports ${from}`);
    if (RUNTIME_ONLY.some((m) => from === m || from!.startsWith(`${m}/`)) && !typeOnly) found.push(`imports ${from} at runtime`);
  }
  for (const [, from] of source.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']/g)) found.push(`loads ${from} dynamically`);
  for (const pattern of GLOBALS) if (pattern.test(source)) found.push(`uses ${pattern.source}`);
  return found;
}

/** dir 下的插件（不含测试）违反的约束，每条带上相对 dir 的文件名 */
export async function pluginViolations(dir: string): Promise<string[]> {
  const report: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan(dir)) {
    if (path.endsWith(".test.ts")) continue;
    const source = await Bun.file(join(dir, path)).text();
    for (const v of violations(source)) report.push(`${relative(dir, join(dir, path))}: ${v}`);
  }
  return report;
}
