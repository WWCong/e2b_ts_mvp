/**
 * 沙盒应用的服务端，即它的 Harness：跑在沙盒（E2B）里，当用户的一台小服务器，自带一个管理 agent，管它自己。
 * 沙盒在隔离的内网里，进来的请求都经业务网关，这里不再认证（网关转发时带的 JWT 怎么用，见 doc/沙盒应用.md）。
 * 现在有管理口：管理员的终端（../client）经它和管理 agent 对话。后续加对外服务口、数据存储、管理 agent 的能力、E2B 模板。
 * 分四层，同 MVP：
 * - 基建（infra）：模型后端、工作区、持久状态，都在 SANDBOX_HOME 下
 * - 领域（plugins）：stdlib 自带的，加上这个应用自己的 fs（写与改不问人）、model（只有 model_complete）
 * - 应用（scripts）：admin（和管理员的对话）、agent（agent 循环）
 * - 接口（serve）：管理口，TCP
 * 配置（环境变量，Bun 会自动读取 .env，见 .env.example）：
 * - SANDBOX_HOME：状态与工作区的根，缺省 ./.sandbox
 * - SANDBOX_HOST：监听的地址，缺省 127.0.0.1；沙盒里是 0.0.0.0（只有网关进得来）
 * - SANDBOX_ADMIN_PORT：管理口，缺省 8081
 * - SANDBOX_WATCH=1：改了 scripts 里的包，运行中重新装载（开发时用）
 * - MODEL 与模型的 key：同 MVP
 * Ctrl-C 或 SIGTERM 优雅关停，进度都在写前日志里，再起来接着做。
 */

import { join } from "node:path";
import { host } from "stdlib";
import { piLlm } from "stdlib/infra/llm";
import { localDir } from "stdlib/infra/volume";
import { adminPort, home } from "../config";

const plugin = (name: string) => join(import.meta.dir, "plugins", name);
const script = (name: string) => join(import.meta.dir, "scripts", name);
const env = process.env;

await host({
  infra: {
    llm: piLlm({ model: env.MODEL ?? "deepseek/deepseek-flash" }),
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
  scripts: [script("agent"), script("admin")],
  watch: env.SANDBOX_WATCH === "1",
  serve: {
    http: {
      port: adminPort,
      hostname: env.SANDBOX_HOST || "127.0.0.1",
      expose: ["admin_say", "admin_reset", "admin_greet"],
    },
  },
});
