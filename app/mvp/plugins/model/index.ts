/**
 * model 插件：原语 model.complete 与 model.compact（8.1、8.3）。调模型经注入的基建 llm（模型后端）：
 * 用哪家、哪个模型、凭据都在装配配置里，这里只管拼请求、处理工具与压缩历史。消息格式用 pi-ai 的。
 * Operation 名本身就合模型对工具名的要求（names.ts），工具名、历史与事件处处同名，不做任何转写。
 * 后续加入：把 usage 记到 Run 上；渲染 run.context；公开给 script 包。
 */

import type { Message, Tool, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op, plugin, type ToolSpec } from "stdlib";
import { estimateTokens, splitAt, transcript, withSummary } from "./compact";

const SUMMARIZE =
  "你负责压缩对话历史。把给你的对话记录写成一份摘要：之后的对话只看得到这份摘要和最近几轮。" +
  "保留用户的目标、要求与偏好，已做的决定与结论，涉及的文件、数据与关键事实，做过的操作与结果，还没完成的事。" +
  "不要编造，不要客套，用中文分条写，尽量简短。";

const toolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export default plugin({ needs: ["llm"] }, (_config, { llm }) => {
  return {
    operations: {
      complete: op({
        input: z.object({
          systemPrompt: z.string().optional(),
          /** pi-ai 的消息格式，原样发给模型 */
          messages: z.array(z.custom<Message>()),
          /** 通常就是调用方的 ctx.tools() */
          tools: z.array(toolSpec).default([]),
        }),
        impl: async (ctx, input) => {
          const reply = await llm.complete(
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
      }),

      /**
       * 压缩历史（8.3）：估出的大小超过 over 才压，最近 keep 轮原样保留，更早的由模型写成摘要，
       * 并进保留部分的第一条用户消息。只在轮次边界调；压缩后的历史交回调用方，下一轮从它开始，同一段只压一次。
       * 轮数不超过 keep 时没有可压的，原样返回
       */
      compact: op({
        input: z.object({
          history: z.array(z.custom<Message>()),
          /** 阈值：历史估计超过这么多 token 才压 */
          over: z.number().int().positive(),
          /** 最近几轮原样保留（一轮从一条用户消息开始） */
          keep: z.number().int().positive().default(2),
        }),
        impl: async (ctx, input) => {
          const { history, over, keep } = input;
          const at = estimateTokens(history) > over ? splitAt(history, keep) : 0;
          if (at === 0) return { history, compacted: false };

          const reply = await llm.complete(
            {
              systemPrompt: SUMMARIZE,
              messages: [{ role: "user", content: transcript(history.slice(0, at)), timestamp: history[at]!.timestamp }],
            },
            { signal: ctx.signal },
          );
          if (reply.stopReason === "error" || reply.stopReason === "aborted") {
            throw new Error(reply.errorMessage ?? reply.stopReason);
          }
          const summary = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
          const [first, ...rest] = history.slice(at);
          return { history: [withSummary(summary, first as UserMessage), ...rest], compacted: true };
        },
      }),
    },
  };
});

/** 去掉 $schema：它只声明 JSON Schema 的版本，有的供应商不认。生成新对象，不改内核给的那份 */
function toTool({ name, description, inputSchema }: ToolSpec): Tool {
  const { $schema: _, ...parameters } = inputSchema;
  return { name, description, parameters: parameters as Tool["parameters"] };
}
