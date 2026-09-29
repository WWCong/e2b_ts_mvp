/**
 * model 插件：原语 model.complete，经 pi-ai 调模型（8.1）。
 * 历史里的工具名用 Operation 名（fs.read）；发给模型前转写成模型接受的形式（fs__read），回来再转回。
 * 转写只在这里做，且每次都相同，不破坏前缀缓存（8.2）。
 * 后续加入：model.compact；把 usage 记到 Run 上；渲染 run.context；公开给 script 包。
 */

import type { AssistantMessage, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op } from "../../kernel/harness";
import type { ToolSpec } from "../../kernel/run";
import { currentModel, models } from "./models";

const toolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const complete = op({
  input: z.object({
    systemPrompt: z.string().optional(),
    /** pi-ai 的消息格式，工具名用 Operation 名 */
    messages: z.array(z.custom<Message>()),
    /** 通常就是调用方的 ctx.tools() */
    tools: z.array(toolSpec).default([]),
  }),
  impl: async (ctx, input) => {
    const reply = await models.complete(
      currentModel(),
      {
        systemPrompt: input.systemPrompt,
        messages: input.messages.map((m) => renameTools(m, toWire)),
        tools: input.tools.map(toTool),
      },
      { signal: ctx.signal },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? reply.stopReason);
    }

    const message = renameTools(reply, fromWire);
    const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    // message：这一轮的完整消息，调用方原样追加进历史；answer：没有工具调用时的回复
    return { message, calls, answer: calls.length > 0 ? null : text };
  },
});

/** 模型的工具名只能用字母、数字、_ 和 -，所以 fs.read ↔ fs__read；Operation 名里不能出现 __ */
function toWire(name: string): string {
  return name.replaceAll(".", "__");
}

function fromWire(name: string): string {
  return name.replaceAll("__", ".");
}

/** 转写一条消息里的工具名：助手消息里的工具调用，以及工具结果 */
function renameTools<M extends Message>(message: M, rename: (name: string) => string): M {
  if (message.role === "assistant") {
    const content = message.content.map((b) => (b.type === "toolCall" ? { ...b, name: rename(b.name) } : b));
    return { ...message, content } as AssistantMessage as M;
  }
  if (message.role === "toolResult") return { ...message, toolName: rename(message.toolName) };
  return message;
}

/** 去掉 $schema：它只声明 JSON Schema 的版本，有的供应商不认。生成新对象，不改内核给的那份 */
function toTool({ name, description, inputSchema }: ToolSpec): Tool {
  const { $schema: _, ...parameters } = inputSchema;
  return { name: toWire(name), description, parameters: parameters as Tool["parameters"] };
}
