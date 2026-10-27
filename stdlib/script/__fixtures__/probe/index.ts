/** 测试用 script 包：在解释器里看看周围有什么，调宿主 */

import { z } from "zod";
import { op, script } from "stdlib";
import { twice } from "./twice";
import greeting from "./greeting.txt" with { type: "text" };

let runs = 0;

/** 一个表达式在解释器里的结果：抛异常就是异常的消息 */
const probe = (fn: () => unknown) => {
  try {
    return fn();
  } catch (err) {
    return `throws: ${(err as Error).message}`;
  }
};

export default script({
  operations: {
    /** 入参的缺省值、包内的模块与文本资源、调宿主、ctx 的信息、模块级状态 */
    echo: op({
      usage: "回声",
      input: z.object({ text: z.string(), times: z.number().default(2) }),
      output: z.object({ text: z.string(), greeting: z.string(), tools: z.array(z.string()), callerPackage: z.string().nullable(), runs: z.number(), now: z.unknown() }),
      impl: async (ctx, input) => ({
        text: twice(input.text, input.times),
        greeting: greeting.trim(),
        tools: ctx.tools().map((t) => t.name),
        callerPackage: ctx.callerPackage ?? null,
        runs: ++runs,
        now: await ctx.call("demo_now", null),
      }),
    }),
    /** 解释器里没有的东西 */
    globals: op({
      usage: "看全局",
      input: z.null(),
      impl: async () => ({
        types: ["process", "Bun", "fetch", "require", "setTimeout", "setInterval", "performance", "console"].map((name) => [name, typeof (globalThis as Record<string, unknown>)[name]]),
        now: probe(() => Date.now()),
        newDate: probe(() => new Date()),
        epoch: probe(() => new Date(0).toISOString()),
        random: probe(() => Math.random()),
      }),
    }),
    /** 调不公开的、直接挂起 */
    reach: op({
      usage: "越界",
      input: z.null(),
      impl: async (ctx) => ({ secret: await ctx.call("demo_secret", null), park: await ctx.park({ schema: {}, payload: null }).catch((e: Error) => e.message) }),
    }),
    fail: op({
      usage: "失败",
      input: z.null(),
      impl: async () => {
        throw new TypeError("坏了");
      },
    }),
    /** 等一个不会返回的调用 */
    hang: op({ usage: "等", input: z.null(), impl: (ctx) => ctx.call("demo_forever", null) }),
  },
});
