/**
 * 沙盒应用的服务端，即它的 Harness：跑在沙盒（E2B）里，当用户的一台小服务器，自带一个管理 agent，管它自己。
 * 沙盒在隔离的内网里，进来的请求都经业务网关，这里不认证；网关转发时带着签发给调用者的 JWT（authorization: Bearer），
 * 服务口把它记进调用者的凭据，树记下调用者，调大模型 API 时带上这个调用者的令牌（stdlib/infra/callers.ts）。
 * 没有管理员：谁能做什么由 Operation 区分（后续）。分四层，同 MVP：
 * - 基建（infra）：模型后端（OpenAI 协议，用调用者的令牌）、工作区、持久状态，都在 SANDBOX_HOME 下
 * - 领域（plugins）：stdlib 自带的，加上这个应用自己的 fs（写与改不问人）、model（只有 model_complete）
 * - 应用（scripts）：manager（和管理 agent 的对话，每个调用者一段）、agent（agent 循环）
 * - 接口（serve）：服务口，TCP
 * 配置（环境变量，Bun 会自动读取 .env，见 .env.example）：
 * - SANDBOX_HOME：状态与工作区的根，缺省 ./.sandbox
 * - SANDBOX_HOST：监听的地址，缺省 127.0.0.1；沙盒里是 0.0.0.0（只有网关进得来）
 * - SANDBOX_PORT：服务口，缺省 8080
 * - SANDBOX_LLM_URL：大模型 API 的地址（如经网关），缺省模型自己的；MODEL：用哪个模型，缺省 deepseek/deepseek-flash
 * - SANDBOX_WATCH=1：改了 scripts 里的包，运行中重新装载（开发时用）
 * Ctrl-C 或 SIGTERM 优雅关停，进度都在写前日志里，再起来接着做。
 */

import { join } from "node:path";
import { host } from "stdlib";
import { callers } from "stdlib/infra/callers";
import { piLlm } from "stdlib/infra/llm";
import { localDir } from "stdlib/infra/volume";
import { home, port } from "../config";

const plugin = (name: string) => join(import.meta.dir, "plugins", name);
const script = (name: string) => join(import.meta.dir, "scripts", name);
const env = process.env;
/** 调用者的令牌：服务口记下，模型后端取用 */
const tokens = callers();

await host({
  infra: {
    llm: piLlm({ model: env.MODEL || "deepseek/deepseek-flash", baseUrl: env.SANDBOX_LLM_URL || undefined, callers: tokens }),
    workspace: localDir(join(home, "workspace")),
    state: localDir(join(home, "state")),
  },
  plugins: [
    "stdlib/plugins/harness",
    "stdlib/plugins/time",
    "stdlib/plugins/ui",
    "stdlib/plugins/kv",
    "stdlib/plugins/package",
    plugin("fs"),
    plugin("model"),
  ],
  scripts: [script("agent"), script("manager")],
  watch: env.SANDBOX_WATCH === "1",
  serve: {
    http: {
      port,
      hostname: env.SANDBOX_HOST || "127.0.0.1",
      callers: tokens,
      expose: ["manager_say", "manager_reset", "manager_greet"],
    },
  },
});
