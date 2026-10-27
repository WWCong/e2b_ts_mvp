/**
 * bun start：Harness 没在跑就起一个（与 bun run serve 同一份装配，main.ts），再开终端客户端（console.ts）；
 * 终端退出时，自己起的 Harness 一并优雅关停——进度在写前日志里，再 bun start 接着做；关停中再按 Ctrl-C 强杀。
 * Harness 已经在跑的（另一个终端里 bun run serve 起的），只开终端，退出时不动它。
 * 起的 Harness 在另一个进程组里：终端里的 Ctrl-C 只到这里，由这里决定怎么停它。它的标准错误照常打到终端。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { reachable } from "stdlib/clients/http";
import { chat } from "./console";
import { socket } from "./paths";

const quit = new AbortController();
let server: ChildProcess | undefined;
let stopping = false;
process.on("SIGINT", () => {
  // 先让终端退出；关停中再按一次：强杀（Harness 收到第二个信号就不再等在途的调用）
  if (!stopping) quit.abort();
  else server?.kill("SIGTERM");
});

let exited: Promise<unknown> = Promise.resolve();
if (!(await reachable(socket))) {
  server = spawn(process.execPath, [join(import.meta.dir, "main.ts")], { stdio: ["ignore", "ignore", "inherit"], detached: true });
  const child = server;
  exited = new Promise((resolve) => child.once("exit", resolve));
  // 等它开始服务；起不来就退出（原因它自己打在标准错误上）
  while (!(await reachable(socket))) {
    if (child.exitCode !== null) process.exit(1);
    await Bun.sleep(20);
  }
}

const { pending } = await chat({ first: process.argv.slice(2).join(" "), signal: quit.signal });
if (server) {
  stopping = true;
  server.kill("SIGTERM");
  await exited;
  if (pending) console.log("\n已停下，进度已保存；再运行 bun start 接着做");
} else if (pending) {
  console.log("\n已断开；这一轮在 Harness 里接着做，再连上时接着显示");
}
process.exit(0);
