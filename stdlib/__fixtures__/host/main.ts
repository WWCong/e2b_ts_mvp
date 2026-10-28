/**
 * 测试用应用；用法 bun main.ts <stateDir> <socket> [bad | watch=<script 包目录>]。写前日志在 stateDir/journal；
 * 装 echo 插件，在 socket 上开 HTTP 服务接口。bad：expose 列了不存在的；watch：再装那个 script 包，
 * 对外加上它的 greeter_hello，改了就重新装载
 */

import { join } from "node:path";
import { host } from "../../host";
import { localDir } from "../../infra/volume";

const [stateDir, socket, mode] = process.argv.slice(2);
const scripts = mode?.startsWith("watch=") ? [mode.slice("watch=".length)] : [];
// 测试应用没有登记装配类型，expose 的名字类型检查不认得
const expose = (mode === "bad" ? ["echo_nope"] : ["echo_say", "echo_wait", "echo_busy", ...(scripts.length ? ["greeter_hello"] : [])]) as never[];
await host({
  infra: { state: localDir(stateDir!) },
  graceMs: 5000,
  serve: { http: { socket, expose } },
  plugins: [join(import.meta.dir, "echo")],
  scripts,
  watch: scripts.length > 0,
});
