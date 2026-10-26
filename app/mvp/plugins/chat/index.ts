/**
 * chat 插件：一段连续的对话。对外（api）提供 chat_say、chat_reset、chat_greet，由入口（如终端）把人说的话交进来。
 * 对话历史存在配置的文件里：每轮读出历史交给 agent_assist，拿回更新后的历史再存。
 * 读与存都是子调用，一轮的三步都记在写前日志里：存完根 Run 才退出、日志才删。中途崩溃或停下，
 * 重启后接着做：已完成的步骤回放，没存的照常存，做完的一轮不会丢。失败的一轮不存，历史不变，这句话可以再说一遍。
 * 同一时间只该有一轮：两轮同时进行会争同一份历史（后续：按会话分开存）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import { op, plugin } from "stdlib";

const none = z.object({});

/** file：对话历史存在哪，放在工作区之外，模型的工具碰不到 */
export default plugin((config: { file: string }) => {
  const read = (): Message[] =>
    existsSync(config.file) ? (JSON.parse(readFileSync(config.file, "utf8")) as { history: Message[] }).history : [];

  /** 先写临时文件再改名：写到一半崩溃也不会留下半截的对话 */
  const write = (history: Message[]) => {
    mkdirSync(dirname(config.file), { recursive: true });
    writeFileSync(`${config.file}.tmp`, JSON.stringify({ history }));
    renameSync(`${config.file}.tmp`, config.file);
  };

  return {
    requires: ["agent"],
    operations: {
      /** 说一句：连同历史交给 agent，存下更新后的历史，返回回答 */
      say: op({
        api: true,
        usage: "说一句话，返回回答。对话历史在服务端保存，下一句接着这段对话",
        input: z.object({ text: z.string() }),
        output: z.string(),
        only: ["chat", "agent"],
        impl: async (ctx, { text }): Promise<string> => {
          const history = await ctx.ops.chat.load({});
          if (!history.ok) throw new Error(`chat_load rejected by ${history.by}: ${history.reason}`);
          const turn = await ctx.ops.agent.assist({ prompt: text, history: history.value });
          if (!turn.ok) throw new Error(`${turn.by}: ${turn.reason}`);
          const saved = await ctx.ops.chat.save({ history: turn.value.history });
          if (!saved.ok) throw new Error(`chat_save rejected by ${saved.by}: ${saved.reason}`);
          return turn.value.answer ?? "";
        },
      }),

      /** 开始新对话：清空历史 */
      reset: op({
        api: true,
        usage: "开始新对话：清空对话历史，返回一句提示",
        input: none,
        output: z.string(),
        impl: async (): Promise<string> => {
          write([]);
          return "已开始新对话";
        },
      }),

      /** 开场白：有之前的对话时说一声 */
      greet: op({
        api: true,
        usage: "开场白：有之前的对话时返回一句提示（几条消息），没有时返回空文字",
        input: none,
        output: z.string(),
        impl: async (): Promise<string> => {
          const count = read().length;
          return count > 0 ? `接着之前的对话（${count} 条消息）；/new 开始新对话` : "";
        },
      }),

      load: op({ input: none, impl: async (): Promise<Message[]> => read() }),

      save: op({
        input: z.object({ history: z.array(z.custom<Message>()) }),
        impl: async (_ctx, { history }): Promise<void> => write(history),
      }),
    },
  };
});
