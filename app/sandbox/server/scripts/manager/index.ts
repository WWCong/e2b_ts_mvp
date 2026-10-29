/**
 * manager：调用者与管理 agent 的对话，从 MVP 的 chat 复制来改的，script 包（应用层）：只调 Operation，不碰基建。
 * 对外（api）提供 manager_say、manager_reset、manager_greet；能不能调由 Operation 区分权限（后续）。
 * 每个调用者（ctx.caller）一段对话，历史存在 kv 里（键 conversation-<调用者>；kv 按调用方的包分开，存的就是 manager 自己的）：
 * 每轮读出历史交给 agent_assist，拿回更新后的历史再存。
 * 读与存都是子调用，一轮的三步都记在写前日志里：存完根 Run 才退出、日志才删。中途崩溃或停下，
 * 重启后接着做：已完成的步骤回放，没存的照常存，做完的一轮不会丢。失败的一轮不存，历史不变，这句话可以再说一遍。
 * 同一时间只该有一轮：两轮同时进行会争同一份历史（后续：按会话分开存）。
 */

import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import { image, op, script, type Ctx } from "stdlib";

const none = z.object({});

export default script({
  requires: ["kv", "agent"],
  operations: {
    /** 说一句：连同历史交给 agent，存下更新后的历史，返回回答 */
    say: op({
      api: true,
      usage: "说一句话，可以带图片（base64），返回回答。对话历史在服务端保存，下一句接着这段对话",
      input: z.object({ text: z.string(), images: z.array(image).default([]) }),
      output: z.string(),
      only: ["kv", "agent"],
      impl: async (ctx, { text, images }): Promise<string> => {
        const history = await load(ctx);
        const turn = await ctx.ops.agent.assist({ prompt: text, images, history });
        if (!turn.ok) throw new Error(`${turn.by}: ${turn.reason}`);
        await save(ctx, turn.value.history);
        return turn.value.answer ?? "";
      },
    }),

    /** 开始新对话：清空历史 */
    reset: op({
      api: true,
      usage: "开始新对话：清空对话历史，返回一句提示",
      input: none,
      output: z.string(),
      only: ["kv"],
      impl: async (ctx): Promise<string> => {
        await save(ctx, []);
        return "已开始新对话";
      },
    }),

    /** 开场白：有之前的对话时说一声 */
    greet: op({
      api: true,
      usage: "开场白：有之前的对话时返回一句提示（几条消息），没有时返回空文字",
      input: none,
      output: z.string(),
      only: ["kv"],
      impl: async (ctx): Promise<string> => {
        const count = (await load(ctx)).length;
        return count > 0 ? `接着之前的对话（${count} 条消息）；/new 开始新对话` : "";
      },
    }),
  },
});

/**
 * 这个调用者的对话存在哪个键：kv 的键只许字母、数字、_ 与 -，别的字符（连 _ 自己）写成 _ 加四位十六进制，不会撞。
 * 没有调用者（本机直接调、没带令牌）的共用一个
 */
function key(ctx: Ctx): string {
  if (!ctx.caller) return "conversation";
  return `conversation-${ctx.caller.replace(/[^a-zA-Z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
}

async function load(ctx: Ctx): Promise<Message[]> {
  const r = await ctx.ops.kv.get({ key: key(ctx) });
  if (!r.ok) throw new Error(`kv_get rejected by ${r.by}: ${r.reason}`);
  return (r.value as Message[] | null) ?? [];
}

async function save(ctx: Ctx, history: Message[]): Promise<void> {
  const r = await ctx.ops.kv.set({ key: key(ctx), value: history });
  if (!r.ok) throw new Error(`kv_set rejected by ${r.by}: ${r.reason}`);
}
