/**
 * 管理员的终端（bun run sandbox:admin）：经管理口连上沙盒的 Harness（../server），和管理 agent 对话。
 * 普通一行调 admin_say，/new 调 admin_reset，开场调 admin_greet；要管理员回答的问题（如审批）在这里问；事件流画成 Run 树。
 * 连哪：SANDBOX_ADMIN_URL，缺省本机的 SANDBOX_ADMIN_PORT。
 * 用法：bun run sandbox:admin；bun run sandbox:admin "第一句话"。/exit、Ctrl-D 或 Ctrl-C 退出——只是终端走了，
 * 在途的那一轮在 Harness 里接着做，再连上时先问还在等的问题、再显示那一轮的结果。
 */

import { runConsole } from "pkg/client/console";
import { httpClient, reachable } from "pkg/client/http";
import { adminPort } from "../config";
import { brief } from "./brief";

const target = { url: process.env.SANDBOX_ADMIN_URL || `http://127.0.0.1:${adminPort}` };

if (!(await reachable(target))) {
  console.error(`连不上沙盒的管理口（${target.url}）：先 bun run sandbox:serve，或设好 SANDBOX_ADMIN_URL`);
  process.exit(1);
}
// 还没开始读输入时的 Ctrl-C 也只让终端退出
const quit = new AbortController();
process.on("SIGINT", () => quit.abort());
const { pending } = await runConsole({
  client: httpClient({ ...target, name: "admin" }),
  say: "admin_say",
  commands: { new: "admin_reset" },
  greet: "admin_greet",
  first: process.argv.slice(2).join(" "),
  brief,
  signal: quit.signal,
});
if (pending) console.log("\n已断开；这一轮在 Harness 里接着做，再连上时接着显示");
process.exit(0);
