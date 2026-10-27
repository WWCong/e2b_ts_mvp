/**
 * MVP 的终端客户端：经 STATE_DIR 下的 socket 连上 Harness（bun run serve 起的，或 bun start 一起起的），在终端里对话。
 * 它在 Harness 外面，和网页、别的系统一样只经 HTTP 服务接口：普通一行调 chat_say，/new 调 chat_reset，开场调 chat_greet；
 * 要人回答的问题在这里问；事件流画成 Run 树（摘要规则见 brief.ts）。
 * 用法：bun run chat；bun run chat "第一句话"。/exit、Ctrl-D 或 Ctrl-C 退出——只是客户端走了，
 * 在途的那一轮在 Harness 里接着做，再连上时先问还在等的问题、再显示那一轮的结果。
 */

import { runConsole } from "stdlib/clients/console";
import { httpClient, reachable } from "stdlib/clients/http";
import { brief } from "./brief";
import { socket } from "./paths";

/** 开一个终端客户端，退出时返回；signal 让它退出 */
export function chat(options: { first?: string; signal?: AbortSignal } = {}) {
  return runConsole({
    client: httpClient({ socket, name: "console" }),
    say: "chat_say",
    commands: { new: "chat_reset" },
    greet: "chat_greet",
    first: options.first,
    brief,
    signal: options.signal,
  });
}

if (import.meta.main) {
  if (!(await reachable(socket))) {
    console.error(`连不上 Harness（${socket}）：先 bun run serve，或用 bun start 一起起`);
    process.exit(1);
  }
  // 还没开始读输入时的 Ctrl-C 也只让客户端退出
  const quit = new AbortController();
  process.on("SIGINT", () => quit.abort());
  const { pending } = await chat({ first: process.argv.slice(2).join(" "), signal: quit.signal });
  if (pending) console.log("\n已断开；这一轮在 Harness 里接着做，再连上时接着显示");
  process.exit(0);
}
