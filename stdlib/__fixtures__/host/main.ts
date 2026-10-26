/**
 * 测试用应用；用法 bun main.ts <mode> <journalDir> [socket]。
 * http：只装 echo 插件，在 socket 上开 HTTP 服务接口，对外 echo_say；badexpose 同上但 expose 列了不存在的；
 * 别的 mode 装入口 probe
 */

import { join } from "node:path";
import { host } from "../../host";

const [mode, journalDir, socket] = process.argv.slice(2);
if (mode === "http" || mode === "badexpose") {
  // 测试应用没有登记装配类型，expose 的名字类型检查不认得
  const expose = [mode === "http" ? "echo_say" : "echo_nope"] as never[];
  await host({ journalDir, graceMs: 5000, serve: { http: { socket, expose } }, plugins: [join(import.meta.dir, "echo")] });
} else {
  await host({ journalDir, graceMs: 5000, plugins: [[join(import.meta.dir, "probe"), { mode }]] });
}
