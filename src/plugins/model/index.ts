/**
 * model 插件：原语 model.complete，经 pi-ai 调模型（8.1）。
 * 模型的工具名只接受字母、数字、_ 和 -。每轮按本轮的工具列表建一张「工具名 → Operation 名」的表：
 * 发出时用工具名（fs.read → fs_read），模型的工具调用再按表查回 Operation 名。
 * 历史原样收发、不改写，前缀天然稳定（8.2）。
 * 后续加入：model.compact；把 usage 记到 Run 上；渲染 run.context；公开给 script 包。
 */

import type { Message, Tool } from "@earendil-works/pi-ai";
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
    /** pi-ai 的消息格式，原样发给模型；里面的工具名就是模型之前看到的工具名 */
    messages: z.array(z.custom<Message>()),
    /** 通常就是调用方的 ctx.tools() */
    tools: z.array(toolSpec).default([]),
  }),
  impl: async (ctx, input) => {
    const operations = new Map<string, string>();
    const tools = input.tools.map((spec) => {
      const tool = toTool(spec);
      const taken = operations.get(tool.name);
      if (taken) throw new Error(`tool name collision: ${taken} and ${spec.name} are both ${tool.name}`);
      operations.set(tool.name, spec.name);
      return tool;
    });

    const reply = await models.complete(
      currentModel(),
      { systemPrompt: input.systemPrompt, messages: input.messages, tools },
      { signal: ctx.signal },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? reply.stopReason);
    }

    // operation：按表查回的 Operation 名；为空说明模型报了本轮工具列表里没有的名字
    const calls = reply.content.flatMap((b) => (b.type === "toolCall" ? [{ ...b, operation: operations.get(b.name) }] : []));
    const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    // message：这一轮的完整消息，调用方原样追加进历史；answer：没有工具调用时的回复
    return { message: reply, calls, answer: calls.length > 0 ? null : text };
  },
});

/** 工具名：Operation 名里字母、数字、_、- 以外的字符（如 .）换成 _ */
function toolName(operation: string): string {
  return operation.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 去掉 $schema：它只声明 JSON Schema 的版本，有的供应商不认。生成新对象，不改内核给的那份 */
function toTool({ name, description, inputSchema }: ToolSpec): Tool {
  const { $schema: _, ...parameters } = inputSchema;
  return { name: toolName(name), description, parameters: parameters as Tool["parameters"] };
}
