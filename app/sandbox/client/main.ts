/**
 * 和管理 agent 对话的终端（bun run sandbox:manager）：经服务口连上沙盒的 Harness（../server）。
 * 普通一行调 manager_say，/new 调 manager_reset，开场调 manager_greet；要人回答的问题（如审批）在这里问；事件流画成 Run 树。
 * 连哪：SANDBOX_URL，缺省本机的 SANDBOX_PORT。SANDBOX_TOKEN 是调用者的令牌（JWT）：经网关时由网关带上，
 * 直连时（本机开发）由这里带上；沙盒用它认出调用者、调大模型 API。
 * 用法：bun run sandbox:manager；bun run sandbox:manager "第一句话"。/exit、Ctrl-D 或 Ctrl-C 退出——只是终端走了，
 * 在途的那一轮在 Harness 里接着做，再连上时先问还在等的问题、再显示那一轮的结果。
 */

import { runConsole } from "pkg/client/console";
import { httpClient, reachable } from "pkg/client/http";
import { port } from "../config";
import { brief } from "./brief";

const env = process.env;
const target = { url: env.SANDBOX_URL || `http://127.0.0.1:${port}`, token: env.SANDBOX_TOKEN || undefined };

if (!(await reachable(target))) {
  console.error(`连不上沙盒（${target.url}）：先 bun run sandbox:serve，或设好 SANDBOX_URL`);
  process.exit(1);
}
// 还没开始读输入时的 Ctrl-C 也只让终端退出
const quit = new AbortController();
process.on("SIGINT", () => quit.abort());
const { pending } = await runConsole({
  client: httpClient({ ...target, name: "manager" }),
  say: "manager_say",
  commands: { new: "manager_reset" },
  greet: "manager_greet",
  first: process.argv.slice(2).join(" "),
  brief,
  signal: quit.signal,
});
if (pending) console.log("\n已断开；这一轮在 Harness 里接着做，再连上时接着显示");
process.exit(0);
