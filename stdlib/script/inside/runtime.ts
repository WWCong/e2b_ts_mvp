/**
 * 解释器里的运行时（7.5）：与 Zod 一起打成解释器的底子（../bundle.ts），求值后存成快照，每个 Run 从快照恢复。
 * - modules：script 包 import 的 stdlib 与 zod（打包时换成取这里的）
 * - declare：读出包的声明交给宿主，入参与出参的 JSON Schema 由包自己的 Zod 生成
 * - run：执行包里的一个 Operation，或一段源码的默认导出（harness_exec）。ctx 的调用经宿主函数 __host_call 交给内核，
 *   入参与结果以 JSON 往返：宿主交进来的是 UTF-8 字节，这里解码（大字符串按字符串交进来很慢，见 ../sandbox.ts）
 * 解释器里本来就没有文件、网络、定时器与宿主对象。时间与随机数也拿掉了：方案里由内核提供、随调用记录回放（7.5），
 * 还没做，要时间就调 time_now。console 的输出收起来随结果交回（harness_exec 交给调用方，script 包的现在丢掉）。
 */

import * as zod from "zod";
import { z } from "zod";
import { calls } from "../../kernel/ops";
import type { ScriptDecl } from "../../kernel/plugin";
import * as stdlib from "./stdlib";

/** 宿主函数：名字在底子里，每个 Run 恢复后接上它这个 Run 的（../sandbox.ts） */
declare function __host_call(request: string): Promise<Uint8Array>;
declare function __host_tools(): string;

const decoder = new TextDecoder();
const fromHost = (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes));

const unavailable = (what: string) => (): never => {
  throw new Error(`${what} is not available in scripts yet: call time_now`);
};
Date.now = unavailable("Date.now()");
Math.random = unavailable("Math.random()");
const OriginalDate = Date;
globalThis.Date = new Proxy(OriginalDate, {
  apply: unavailable("Date()"),
  construct: (target, args, newTarget) => (args.length === 0 ? unavailable("new Date()")() : Reflect.construct(target, args, newTarget)),
});
delete (globalThis as { performance?: unknown }).performance;

/** console 的输出，一次 run 一份；太长的截断 */
const LOG_LIMIT = 10_000;
let logs: string[] = [];
let logged = 0;
const show = (value: unknown) =>
  typeof value === "string" ? value : value instanceof Error ? `${value.name}: ${value.message}` : (JSON.stringify(value) ?? String(value));
const log = (...args: unknown[]) => {
  if (logged > LOG_LIMIT) return;
  const line = args.map(show).join(" ");
  logged += line.length;
  logs.push(logged > LOG_LIMIT ? `${line.slice(0, LOG_LIMIT - logged + line.length)}…（输出太长，后面的不要了）` : line);
};
(globalThis as { console?: unknown }).console = { log, info: log, warn: log, error: log, debug: log };

const harness = {
  modules: { stdlib, zod },
  /** 包的默认导出：包的代码求值时放进来（../bundle.ts 生成的入口） */
  pkg: undefined as ScriptDecl | undefined,

  /** 包的声明，JSON。pkg 是包名，只用于报错 */
  declare(pkg: string): string {
    const decl = harness.pkg;
    if (decl?.kind !== "script") throw new Error("default export is not script()");
    const { object } = decl;
    const schema = (key: string, type: z.ZodType, io: "input" | "output") => {
      try {
        // io: "input" 按调用方要填的形状生成：带默认值的字段是可选的
        return z.toJSONSchema(type, { io });
      } catch (err) {
        throw new Error(`${pkg}_${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    return JSON.stringify({
      keys: Object.keys(object),
      requires: object.requires,
      operations: Object.entries(object.operations ?? {}).map(([key, op]) => ({
        key,
        usage: op.usage,
        public: op.public,
        tool: op.tool,
        api: op.api,
        only: op.only,
        exclude: op.exclude,
        decorators: op.decorators,
        input: schema(key, op.input, "input"),
        output: op.output && schema(key, op.output, "output"),
      })),
    });
  },

  /**
   * 执行包里的 Operation key；key 为 null 时执行默认导出的函数（一段源码）。
   * request 是 { input, runId, attempt, callerPackage }，兑现为 JSON 的 { value, logs }
   */
  async run(key: string | null, request: Uint8Array): Promise<string> {
    const { input, runId, attempt, callerPackage } = fromHost(request);
    logs = [];
    logged = 0;
    const call = async (name: string, input: unknown) => fromHost(await __host_call(JSON.stringify({ name, input })));
    const ctx = {
      runId,
      attempt,
      callerPackage,
      ...calls(call),
      tools: () => JSON.parse(__host_tools()),
      park: () => Promise.reject(new Error("a script cannot park directly: call an operation")),
    };
    const impl = key === null ? (harness.pkg as unknown) : harness.pkg!.object.operations[key]!.impl;
    if (typeof impl !== "function") throw new Error("default export is not a function: export default async (ctx, input) => …");
    const value = await impl(ctx, input);
    return JSON.stringify({ value, logs });
  },
};

(globalThis as { __harness?: typeof harness }).__harness = harness;
