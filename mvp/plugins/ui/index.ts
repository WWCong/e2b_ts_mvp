/**
 * ui 插件：给人看的问题（3.5）。约定经 stdlib_park 挂起时 payload 为 Question，
 * 入口程序认得这个格式，在终端里问人，把回答 unpark 回来（mvp/prompt.ts）。
 * 方案里 ask 属于 script 包 agent-ui，approval 是单独的装饰器；MVP 里都写在这个原生插件里。
 */

import { z } from "zod";
import { decorator, op } from "../../../src/kernel/harness";

/** 约定的 payload 格式：给了 options 时回答只能是其中之一，否则是任意文本 */
export type Question = { question: string; options?: string[] };

export const ask = op({
  usage: "向用户提一个问题并等他回答。信息不够、或有几种做法需要用户拍板时使用；给了 options 时用户只能从中选一个",
  public: true,
  input: z.object({ question: z.string(), options: z.array(z.string()).min(1).optional() }),
  impl: async (ctx, input) => {
    const r = await ctx.call("stdlib_park", parkInput(input));
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  },
});

/** 审批：放行前先问人，回答 yes 才执行；其他回答、撤回或被短路都拒绝 */
export const approval = decorator({
  onError: "closed",
  fn: async (ctx, run, next) => {
    const detail = JSON.stringify(run.input);
    const question = `允许执行 ${run.operation}？${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`;
    const r = await ctx.call("stdlib_park", parkInput({ question, options: ["yes", "no"] }));
    if (r.ok && r.value === "yes") return next();
    return { ok: false, by: "ui_approval", reason: r.ok ? "用户拒绝了这次调用" : r.reason, retryable: false };
  },
});

/** 按约定格式组 stdlib_park 的入参 */
function parkInput(q: Question) {
  const schema = q.options ? z.enum(q.options as [string, ...string[]]) : z.string();
  return { schema: z.toJSONSchema(schema), payload: q };
}
