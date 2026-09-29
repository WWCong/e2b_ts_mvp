/**
 * model 插件：原语 model.complete，经 pi-ai 调模型（8.1）。
 * Operation 名本身就合模型对工具名的要求（names.ts），工具名、历史与事件处处同名，不做任何转写。
 * 后续加入：model.compact；把 usage 记到 Run 上；渲染 run.context；公开给 script 包。
 */

import type { Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op } from "../../../src/kernel/harness";
import type { ToolSpec } from "../../../src/kernel/run";
import { currentModel, models } from "./models";

const toolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const complete = op({
  input: z.object({
    systemPrompt: z.string().optional(),
    /** pi-ai 的消息格式，原样发给模型 */
    messages: z.array(z.custom<Message>()),
    /** 通常就是调用方的 ctx.tools() */
    tools: z.array(toolSpec).default([]),
  }),
  impl: async (ctx, input) => {
    const reply = await models.complete(
      currentModel(),
      { systemPrompt: input.systemPrompt, messages: input.messages, tools: input.tools.map(toTool) },
      { signal: ctx.signal },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? reply.stopReason);
    }

    const calls = reply.content.filter((b): b is ToolCall => b.type === "toolCall");
    const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    // message：这一轮的完整消息，调用方原样追加进历史；answer：没有工具调用时的回复
    return { message: reply, calls, answer: calls.length > 0 ? null : text };
  },
});

/** 去掉 $schema：它只声明 JSON Schema 的版本，有的供应商不认。生成新对象，不改内核给的那份 */
function toTool({ name, description, inputSchema }: ToolSpec): Tool {
  const { $schema: _, ...parameters } = inputSchema;
  return { name, description, parameters: parameters as Tool["parameters"] };
}
