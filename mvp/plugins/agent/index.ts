/**
 * agent 插件：最小的 agent 循环（3.3）。调模型 → 模型要调工具就逐个 ctx.call → 结果追加进历史 → 再调模型，
 * 直到模型不再调工具。被拒绝的调用原样作为出错的工具结果交给模型，由它改道或重试。
 * MVP 里写成插件；方案中 agent 循环是 script 包，等 script 运行时做好再挪过去。
 * 后续加入：多轮对话（入参带 history）、model.compact 压缩历史。
 */

import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op } from "../../../src/kernel/harness";
import type { Result } from "../../../src/kernel/run";

const PERSONA =
  "你是工作区助手。需要查看或修改文件时使用工具；信息不够或有几种做法需要用户拍板时，用 ui_ask 问用户。做完后用中文简要回答用户。";
const MAX_TURNS = 20;

/** model_complete 的出参 */
type Reply = { message: AssistantMessage; calls: ToolCall[]; answer: string | null };

export const assist = op({
  input: z.object({ prompt: z.string() }),
  only: ["fs", "model", "ui"],
  impl: async (ctx, input) => {
    const tools = ctx.tools();
    const history: Message[] = [{ role: "user", content: input.prompt, timestamp: Date.now() }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await ctx.call("model_complete", { systemPrompt: PERSONA, messages: history, tools });
      if (!r.ok) throw new Error(`model_complete rejected by ${r.by}: ${r.reason}`);
      const { message, calls, answer } = r.value as Reply;
      history.push(message);
      if (calls.length === 0) return { answer };

      const results = await Promise.all(calls.map((call) => ctx.call(call.name, call.arguments)));
      calls.forEach((call, i) => history.push(toolResult(call, results[i]!)));
    }
    throw new Error(`no answer after ${MAX_TURNS} turns`);
  },
});

/** 调用结果写成给模型看的工具结果：成功给值，被拒给拒绝的来由 */
function toolResult(call: ToolCall, result: Result): Message {
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
    timestamp: Date.now(),
  };
}
