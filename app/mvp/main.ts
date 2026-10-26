/**
 * MVP 的装配，交给宿主（stdlib 的 host）。分四层：
 * - 基建（infra）：Harness 外面给的能力——模型后端、工作区、持久状态。换实现（比如工作区换成 rclone+FUSE 挂载）只改这里
 * - 领域（plugins 里的 fs、model、ui 等）：插件声明需要哪些基建，宿主注入
 * - 应用（plugins 里的 agent、chat）：编排，以后是 script 包
 * - 接口（serve）：哪些 Operation 怎么对外
 * 终端入口（console）把人说的话交给 chat；打印事件的是 trace。
 * 本地状态都在 STATE_DIR 下，在工作区之外：写前日志在 journal/，插件的存储在 store/<包名>/（chat 的对话历史），
 * 还有 HTTP 服务接口的 Unix socket（harness.sock；socket 要在本地文件系统上，持久状态换成挂载的远程存储时要另放）。
 * 用法：bun start 进入对话；bun start "第一句话" 从这句开始。/new 开始新对话，/exit 或 Ctrl-D 退出。
 * Ctrl-C 停下并保留进度（再按一次不等在途的调用），进程被杀也一样；再运行 bun start 先接着做没做完的那一轮，
 * 已完成的步骤不再执行，停在的问题原样再问一次。
 * 配置见 .env.example（Bun 会自动读取 .env）；模型的 key 由 provider 从环境变量读（DEEPSEEK_API_KEY 等）。
 */

import { join } from "node:path";
import { host } from "stdlib";
import { piLlm } from "stdlib/infra/llm";
import { localDir } from "stdlib/infra/volume";

const app = (name: string) => join(import.meta.dir, "plugins", name);
const env = process.env;
const stateDir = env.STATE_DIR ?? ".harness";

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
    app("fs"),
    app("model"),
    app("agent"),
    app("chat"),
    app("trace"),
    [
      "stdlib/entries/console",
      {
        say: "chat_say",
        commands: { new: "chat_reset" },
        greet: "chat_greet",
        first: process.argv.slice(2).join(" "),
      },
    ],
  ],
  serve: {
    http: { socket: join(stateDir, "harness.sock"), expose: ["chat_say", "chat_reset", "chat_greet"] },
  },
});
