/**
 * 分层的约束。包与内核在同一个进程里，挡不住 import，所以在测试里查。
 * - 领域层（plugins/）：插件只经注入的基建做 IO（stdlib/infra）——不直接 import 文件、网络、子进程，
 *   不在运行时用模型 SDK（import type 可以，消息格式用它的），不读环境变量、不直接 fetch。
 *   例外：pi-tools（pi 的编码工具）照常 import，它的文件操作换成了我们注入的（fs 插件的 operations.ts）。
 * - 应用层（scripts/）：script 包只调 Operation（7.5）——运行时只 import stdlib、zod 与包里的文件（import type 不限），
 *   不碰宿主对象（Bun、process、fetch、globalThis…）、定时器、Date 与 Math.random（时间经 time_now 取，重放才一致）。
 *   公开不公开由内核在调用时查；这里查的是它们没有别的路可走。以后在内嵌的解释器里跑，这些本就没有。
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";

const MODULES = ["fs", "fs/promises", "child_process", "net", "http", "https", "dgram", "worker_threads"];
const RUNTIME_ONLY = ["@earendil-works/pi-ai"];
const GLOBALS = [/\bBun\.(file|write|spawn|spawnSync|connect|listen|serve)\b/, /\bfetch\(/, /\bprocess\.env\b/];

const SCRIPT_IMPORTS = ["stdlib", "zod"];
const SCRIPT_GLOBALS = [
  /\b(Bun|process|globalThis|require|fetch|eval|Function)\b/,
  /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/,
  /\bDate\b/,
  /\bMath\.random\b/,
];

/** 源文件里的 import / export … from：[原文, 是否 import type, 模块] */
const imports = (source: string) =>
  [...source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm)].map(([, typeOnly, from]) => ({
    typeOnly: Boolean(typeOnly),
    from: from!,
  }));

const dynamic = (source: string) => [...source.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']/g)].map(([, from]) => `loads ${from} dynamically`);

/** 插件违反了哪些约束 */
function violations(source: string): string[] {
  const found: string[] = [];
  for (const { typeOnly, from } of imports(source)) {
    const bare = from.replace(/^node:/, "");
    if (MODULES.includes(bare)) found.push(`imports ${from}`);
    if (RUNTIME_ONLY.some((m) => from === m || from.startsWith(`${m}/`)) && !typeOnly) found.push(`imports ${from} at runtime`);
  }
  found.push(...dynamic(source));
  for (const pattern of GLOBALS) if (pattern.test(source)) found.push(`uses ${pattern.source}`);
  return found;
}

/** script 包违反了哪些约束 */
function scriptViolations(source: string): string[] {
  const found: string[] = [];
  for (const { typeOnly, from } of imports(source)) {
    if (!typeOnly && !SCRIPT_IMPORTS.includes(from) && !from.startsWith("./")) found.push(`imports ${from} at runtime`);
  }
  found.push(...dynamic(source));
  for (const pattern of SCRIPT_GLOBALS) {
    const hit = source.match(pattern);
    if (hit) found.push(`uses ${hit[0]}`);
  }
  return found;
}

async function scan(dir: string, check: (source: string) => string[]): Promise<string[]> {
  const report: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan(dir)) {
    if (path.endsWith(".test.ts")) continue;
    const source = await Bun.file(join(dir, path)).text();
    for (const v of check(source)) report.push(`${relative(import.meta.dir, join(dir, path))}: ${v}`);
  }
  return report;
}

describe("分层", () => {
  test("检查本身认得出插件违规的写法", () => {
    expect(violations('import { readFile } from "node:fs/promises";')).toEqual(["imports node:fs/promises"]);
    expect(violations('import { spawn } from "child_process";')).toEqual(["imports child_process"]);
    expect(violations('import { createModels } from "@earendil-works/pi-ai";')).toEqual(["imports @earendil-works/pi-ai at runtime"]);
    expect(violations('import type { Message } from "@earendil-works/pi-ai";')).toEqual([]);
    expect(violations("const key = process.env.KEY;")).toEqual(["uses \\bprocess\\.env\\b"]);
    expect(violations('await import("node:fs");')).toEqual(["loads node:fs dynamically"]);
    expect(violations('import { posix } from "node:path";\nimport { op } from "stdlib";')).toEqual([]);
  });

  test("检查本身认得出 script 包违规的写法", () => {
    expect(scriptViolations('import { op, script } from "stdlib";\nimport { z } from "zod";\nimport { x } from "./x";')).toEqual([]);
    expect(scriptViolations('import type { Message } from "@earendil-works/pi-ai";')).toEqual([]);
    expect(scriptViolations('import { join } from "node:path";')).toEqual(["imports node:path at runtime"]);
    expect(scriptViolations('import { localDir } from "stdlib/infra/volume";')).toEqual(["imports stdlib/infra/volume at runtime"]);
    expect(scriptViolations("const t = Date.now();")).toEqual(["uses Date"]);
    expect(scriptViolations("await new Promise((r) => setTimeout(r, 10));")).toEqual(["uses setTimeout"]);
    expect(scriptViolations("const r = Math.random();")).toEqual(["uses Math.random"]);
    expect(scriptViolations("const s = Bun.spawn(['ls']);")).toEqual(["uses Bun"]);
  });

  test("app 的插件不直接做 IO，只用注入的基建", async () => {
    expect(await scan(join(import.meta.dir, "plugins"), violations)).toEqual([]);
  });

  test("app 的 script 包只调 Operation", async () => {
    expect(await scan(join(import.meta.dir, "scripts"), scriptViolations)).toEqual([]);
  });
});
