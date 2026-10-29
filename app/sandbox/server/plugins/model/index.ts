/**
 * model 插件（沙盒应用的）：只有 model_complete，调一次模型。经注入的基建 llm（模型后端）调：
 * 用哪家、哪个模型在装配配置里，凭据是这棵树的调用者的（把 ctx.caller 交给 llm），这里只管拼请求、处理工具。消息格式用 pi-ai 的。
 * 与 MVP 的不同：不做语义压缩，历史怎么管由调用方决定。
 * 公开（script 包能调，如 agent），不交给模型当工具（8.1：工具不含 model 包自身）。
 */

import type { Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op, opaque, plugin, type ToolSpec } from "stdlib";

const toolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export default plugin({ needs: ["llm"] }, (_config, { llm }) => ({
  operations: {
    complete: op({
      usage: "调一次模型：给系统提示、消息与工具，返回这一轮的消息、要调的工具与回答",
      public: true,
      tool: false,
      input: z.object({
        systemPrompt: z.string().optional(),
        /** pi-ai 的消息格式，原样发给模型 */
        messages: z.array(opaque<Message>()),
        /** 通常就是调用方的 ctx.tools() */
        tools: z.array(toolSpec).default([]),
      }),
      impl: async (ctx, input) => {
        const reply = await llm.complete(
          { systemPrompt: input.systemPrompt, messages: input.messages, tools: input.tools.map(toTool) },
          { signal: ctx.signal, caller: ctx.caller },
        );
        if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);

        const calls = reply.content.filter((b): b is ToolCall => b.type === "toolCall");
        const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        // message：这一轮的完整消息，调用方原样追加进历史；answer：没有工具调用时的回复
        return { message: reply, calls, answer: calls.length > 0 ? null : text };
      },
    }),
  },
}));

/** 去掉 $schema：它只声明 JSON Schema 的版本，有的供应商不认。生成新对象，不改内核给的那份 */
function toTool({ name, description, inputSchema }: ToolSpec): Tool {
  const { $schema: _, ...parameters } = inputSchema;
  return { name, description, parameters: parameters as Tool["parameters"] };
}
