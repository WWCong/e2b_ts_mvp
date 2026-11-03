/**
 * chat 插件：结构里的聊天。一个聊天是结构里的一个 .chat 文件（JSON Lines，一行一条消息），每个结构有主聊天 main.chat。
 * 会话对所有人公开：谁都能读、能说；说话的人是调用者（网关带来的身份）。
 * 发一条消息就是一次 chat_post：它的结果（带 path 的消息）随 run.exited 进事件流，网页据它实时显示。
 */

import { z } from "zod";
import { op, opaque, plugin } from "stdlib";
import { treePath } from "../tree";

export type Message = { id: string; author: string; text: string; at: number };

/** 聊天的路径：某个结构下的 名字.chat */
const chatPath = treePath.refine((p) => /(^|\/)[\p{L}\p{N}_-]+\.chat$/u.test(p), "path: <structure>/<name>.chat");

export default plugin({ needs: ["workspace"] }, (_config, { workspace: tree }) => {
  /** 每个聊天文件一条队：读出、追加、整个写回，同一个文件的不交错 */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const next = (queues.get(path) ?? Promise.resolve()).then(fn, fn);
    queues.set(path, next.catch(() => {}));
    return next;
  };
  const load = async (path: string): Promise<Message[]> => {
    if (!(await tree.stat(path))) return [];
    const text = new TextDecoder().decode(await tree.read(path));
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Message);
  };
  const structureOf = (path: string) => path.split("/").slice(0, -1).join("/");

  return {
    operations: {
      read: op({
        api: true,
        usage: "一个聊天的全部消息，按先后；还没人说过话的是空的",
        input: z.object({ path: chatPath }),
        output: z.array(opaque<Message>()),
        impl: (_ctx, { path }) => load(path),
      }),

      post: op({
        api: true,
        usage: "在一个聊天里说一句（结构要已经有了）；说话的人是调用者。返回这条消息与它所在的聊天",
        input: z.object({ path: chatPath, text: z.string().trim().min(1).max(20_000) }),
        output: opaque<Message & { path: string }>(),
        impl: (ctx, { path, text }) =>
          serial(path, async () => {
            const dir = structureOf(path);
            if (dir && (await tree.stat(dir))?.kind !== "dir") throw new Error(`no such structure: ${dir}`);
            const messages = await load(path);
            // id 是这次调用的 runId：崩溃后重新执行时，已经写进去的不再写一遍
            const message = messages.find((m) => m.id === ctx.runId) ?? { id: ctx.runId, author: ctx.caller ?? "匿名", text, at: Date.now() };
            if (!messages.includes(message)) await tree.write(path, [...messages, message].map((m) => `${JSON.stringify(m)}\n`).join(""));
            return { ...message, path };
          }),
      }),
    },
  };
});
