/**
 * MVP 的服务端，即它的 Harness：装配交给宿主（stdlib 的 host），bun run serve 起它。分四层：
 * - 基建（infra）：Harness 外面给的能力——模型后端、工作区、持久状态。换实现（比如工作区换成 rclone+FUSE 挂载）只改这里
 * - 领域（plugins）：插件，fs、model 与 stdlib 自带的 ui、kv 等；插件声明需要哪些基建，宿主注入
 * - 应用（scripts）：script 包 agent、chat，编排：只能调公开的 Operation，不碰基建（状态存在 kv 里）
 * - 接口（serve）：哪些 Operation 怎么对外
 * 界面不在这里：MVP 的客户端（../client）经服务接口连上来，和网页、别的系统一样；bun start 把两边一起起（../start.ts）。
 * 本地状态都在 STATE_DIR 下，在工作区之外：写前日志在 journal/，插件的存储在 store/<包名>/（chat 的对话历史在 kv 的那块里：store/kv/chat/），
 * 还有 HTTP 服务接口的 Unix socket（harness.sock；socket 要在本地文件系统上，持久状态换成挂载的远程存储时要另放）。
 * Ctrl-C 或 SIGTERM 优雅关停（再来一次不等在途的调用），进程被杀也一样，进度都在写前日志里；再起来接着做没做完的。
 * 配置见 .env.example（Bun 会自动读取 .env）；模型的 key 由 provider 从环境变量读（DEEPSEEK_API_KEY 等）。
 */

import { join } from "node:path";
import { host } from "stdlib";
import { piLlm } from "stdlib/infra/llm";
import { localDir } from "stdlib/infra/volume";
import { socket, stateDir } from "../paths";

const plugin = (name: string) => join(import.meta.dir, "plugins", name);
const script = (name: string) => join(import.meta.dir, "scripts", name);
const env = process.env;

await host({
  infra: {
    llm: piLlm({ model: env.MODEL ?? "deepseek/deepseek-flash" }),
    workspace: localDir(env.WORKSPACE_DIR ?? "workspace"),
    state: localDir(stateDir),
  },
  plugins: [
    "stdlib/plugins/harness",
    "stdlib/plugins/time",
    "stdlib/plugins/ui",
    "stdlib/plugins/kv",
    plugin("fs"),
    plugin("model"),
  ],
  scripts: [script("agent"), script("chat")],
  serve: {
    http: { socket, expose: ["chat_say", "chat_reset", "chat_greet"] },
  },
});
