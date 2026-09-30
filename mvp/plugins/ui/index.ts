/**
 * ui 插件：给人看的问题（3.5）。约定经 stdlib_park 挂起时 payload 为 Question、回答为 Answer，
 * 入口程序认得这个格式，在终端里问人，把回答 unpark 回来（mvp/prompt.ts）。
 * 方案里 ask 属于 script 包 agent-ui，approval 是单独的装饰器；MVP 里都写在这个原生插件里。
 */

import { z } from "zod";
import { decorator, op } from "../../../src/kernel/harness";

/** 约定的 payload 格式 */
export type Question = { question: string; options?: string[] };

/**
 * 约定的回答格式：option 是选中的选项（只在给了 options 时有）；
 * text 是人写的文字：选了选项时是补充说明，没选时就是回答本身。两者至少有一个。
 */
export type Answer = { option?: string; text?: string };

export const ask = op({
  usage:
    "向用户提一个问题并等他回答。信息不够、或有几种做法需要用户拍板时使用。" +
    "返回 { option, text }：option 是用户选的选项（给了 options 且用户选了时才有），text 是用户的补充说明或自己写的回答",
  public: true,
  input: z.object({ question: z.string(), options: z.array(z.string()).min(1).optional() }),
  impl: async (ctx, input) => {
    const r = await ctx.call("stdlib_park", parkInput(input));
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  },
});

/**
 * 审批：放行前先问人。
 * 选 yes 才执行；带了补充说明就连同结果一起交回，结果改为 { result, userNote }。
 * 选 no 或写了别的回答都不执行：有说明时原因里带上说明、可按说明改了再试；撤回或被短路时原因取它们的。
 */
export const approval = decorator({
  onError: "closed",
  fn: async (ctx, run, next) => {
    const detail = JSON.stringify(run.input);
    const question = `允许执行 ${run.operation}？${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`;
    const r = await ctx.call("stdlib_park", parkInput({ question, options: ["yes", "no"] }));
    if (!r.ok) return { ok: false, by: "ui_approval", reason: r.reason, retryable: false };

    const { option, text } = r.value as Answer;
    if (option === "yes") {
      const result = await next();
      return result.ok && text ? { ok: true, value: { result: result.value, userNote: text } } : result;
    }
    const reason = text ? `用户没有批准：${text}` : "用户拒绝了这次调用";
    return { ok: false, by: "ui_approval", reason, retryable: Boolean(text) };
  },
});

/** 按约定格式组 stdlib_park 的入参：回答的 schema 由选项决定 */
function parkInput(q: Question) {
  const answer = q.options
    ? z.object({ option: z.enum(q.options as [string, ...string[]]).optional(), text: z.string().optional() })
    : z.object({ text: z.string() });
  return { schema: z.toJSONSchema(answer), payload: q };
}
