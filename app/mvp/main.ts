/**
 * MVP 的装配：装哪些插件、各自什么配置，交给宿主（stdlib 的 host）。逻辑都在插件里：
 * 终端入口（console）把人说的话交给对话（chat），对话交给 agent 循环（agent），agent 调模型（model）、
 * 文件工具（fs）、问人（ui）；打印事件的是 trace。
 * 本地状态都在 STATE_DIR 下，在工作区之外：写前日志（journal/）、对话历史（conversation.json），
 * 以及对外服务接口的 Unix socket（harness.sock，HTTP，见 stdlib/serve/http.ts）。对外的只有 serve 里 expose 列的。
 * 用法：bun start 进入对话；bun start "第一句话" 从这句开始。/new 开始新对话，/exit 或 Ctrl-D 退出。
 * Ctrl-C 停下并保留进度（再按一次不等在途的调用），进程被杀也一样；再运行 bun start 先接着做没做完的那一轮，
 * 已完成的步骤不再执行，停在的问题原样再问一次。
 * 配置见 .env.example（Bun 会自动读取 .env），在这里转成各插件的配置。
 */

import { join } from "node:path";
import { host } from "stdlib";

const app = (name: string) => join(import.meta.dir, "plugins", name);
const stateDir = process.env.STATE_DIR ?? ".harness";

await host({
  journalDir: join(stateDir, "journal"),
  serve: {
    http: { socket: join(stateDir, "harness.sock"), expose: ["chat_say", "chat_reset", "chat_greet"] },
  },
  plugins: [
    "stdlib/plugins/harness",
    "stdlib/plugins/time",
    "stdlib/plugins/ui",
    [app("fs"), { workspace: process.env.WORKSPACE_DIR }],
    [app("model"), { model: process.env.MODEL }],
    app("agent"),
    [app("chat"), { file: join(stateDir, "conversation.json") }],
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
});
