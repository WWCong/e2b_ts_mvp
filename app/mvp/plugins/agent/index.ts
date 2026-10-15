/**
 * agent 插件：最小的 agent 循环（3.3）。调模型 → 模型要调工具就逐个 ctx.call → 结果追加进历史 → 再调模型，
 * 直到模型不再调工具。被拒绝的调用原样作为出错的工具结果交给模型，由它改道或重试。
 * 多轮对话：入参带之前的 history，出参是回答与更新后的 history（含这一轮的工具调用与结果），下一轮原样传回，
 * 交给模型的前缀逐字节不变。对话存在哪由调用方决定，agent 本身不存状态。
 * MVP 里写成插件；方案中 agent 循环是 script 包，等 script 运行时做好再挪过去。
 * 后续加入：model.compact 压缩历史。
 */

import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op, plugin, type Ctx, type Result } from "stdlib";

const PERSONA =
  "你是工作区助手。需要查看或修改文件时使用工具；信息不够或有几种做法需要用户拍板时，用 ui_ask 问用户。做完后用中文简要回答用户。";
const MAX_TURNS = 20;

const assist = op({
  input: z.object({
    prompt: z.string(),
    /** 之前几轮的历史：上一轮出参里的 history，原样传回 */
    history: z.array(z.custom<Message>()).default([]),
  }),
  only: ["fs", "model", "ui", "time"],
  impl: async (ctx, input) => {
    const tools = ctx.tools();
    const history: Message[] = [...input.history, { role: "user", content: input.prompt, timestamp: await now(ctx) }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await ctx.ops.model.complete({ systemPrompt: PERSONA, messages: history, tools });
      if (!r.ok) throw new Error(`model_complete rejected by ${r.by}: ${r.reason}`);
      const { message, calls, answer } = r.value;
      history.push(message);
      if (calls.length === 0) return { answer, history };

      // 模型挑的工具：名字是变量，按名字调
      const results = await Promise.all(calls.map((call) => ctx.call(call.name, call.arguments)));
      const timestamp = await now(ctx);
      calls.forEach((call, i) => history.push(toolResult(call, results[i]!, timestamp)));
    }
    throw new Error(`no answer after ${MAX_TURNS} turns`);
  },
});

export default plugin(() => ({ requires: ["model", "time"], operations: { assist } }));

/** 消息的时间戳经 time_now 取：恢复重放时回送当初的值，交给模型的历史与原来一致，调用才比对得上 */
async function now(ctx: Ctx): Promise<number> {
  const r = await ctx.ops.time.now(null);
  if (!r.ok) throw new Error(`time_now rejected by ${r.by}: ${r.reason}`);
  return r.value;
}

/** 调用结果写成给模型看的工具结果：成功给值，被拒给拒绝的来由 */
function toolResult(call: ToolCall, result: Result, timestamp: number): Message {
  const text = result.ok
    ? typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value)
    : JSON.stringify({ rejectedBy: result.by, reason: result.reason, retryable: result.retryable });
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: !result.ok,
    timestamp,
  };
}
