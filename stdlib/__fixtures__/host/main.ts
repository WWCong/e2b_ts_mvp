/**
 * 测试用应用；用法 bun main.ts <stateDir> <socket> [badexpose]。写前日志在 stateDir/journal；
 * 装 echo 插件，在 socket 上开 HTTP 服务接口。badexpose：expose 列了不存在的
 */

import { join } from "node:path";
import { host } from "../../host";
import { localDir } from "../../infra/volume";

const [stateDir, socket, bad] = process.argv.slice(2);
// 测试应用没有登记装配类型，expose 的名字类型检查不认得
const expose = (bad ? ["echo_nope"] : ["echo_say", "echo_wait", "echo_busy"]) as never[];
await host({
  infra: { state: localDir(stateDir!) },
  graceMs: 5000,
  serve: { http: { socket, expose } },
  plugins: [join(import.meta.dir, "echo")],
});
