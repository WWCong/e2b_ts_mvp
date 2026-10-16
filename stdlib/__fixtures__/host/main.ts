/**
 * 测试用应用；用法 bun main.ts <mode> <journalDir> [socket]。
 * http：只装 echo 插件，在 socket 上开 HTTP 服务接口；别的 mode 装入口 probe
 */

import { join } from "node:path";
import { host } from "../../host";

const [mode, journalDir, socket] = process.argv.slice(2);
if (mode === "http") {
  await host({ journalDir, graceMs: 5000, serve: { http: { socket } }, plugins: [join(import.meta.dir, "echo")] });
} else {
  await host({ journalDir, graceMs: 5000, plugins: [[join(import.meta.dir, "probe"), { mode }]] });
}
