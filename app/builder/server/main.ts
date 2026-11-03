/**
 * builder：一台机器上常驻的 Harness，维护一个项目。内容组织成一棵树（tree 插件）：目录是结构（一件事），
 * 文件是产物，每个结构有自己的聊天（chat 插件），对所有人公开。界面是内网上的网页（../ui），
 * 从这里打开：左边树、中间产物、右边当前结构的聊天。
 * 现在有：树、产物的显示、主聊天（多人实时）。后续：@builder、分支聊天、待办与进度、溯源、维护项目、自维护。
 * 配置（环境变量，Bun 会自动读取 .env，见 .env.example）：
 * - BUILDER_HOME：根，缺省 ./.builder；tree/ 是树，state/ 是持久状态
 * - BUILDER_PORT（缺省 8090）、BUILDER_HOST（缺省 127.0.0.1；内网上开给网关时改成 0.0.0.0）
 * - BUILDER_USER_HEADER：网关把调用者的身份放在哪个请求头里，缺省 x-builder-user
 * Ctrl-C 或 SIGTERM 优雅关停。
 */

import { join } from "node:path";
import { host } from "stdlib";
import { localDir } from "stdlib/infra/volume";
import { home, hostname, port, userHeader } from "../config";

const plugin = (name: string) => join(import.meta.dir, "plugins", name);
const tree = join(home, "tree");

await host({
  infra: {
    workspace: localDir(tree),
    state: localDir(join(home, "state")),
  },
  plugins: [plugin("tree"), plugin("chat")],
  serve: {
    http: {
      port,
      hostname,
      callerHeader: userHeader,
      // 会话对所有人公开
      visibility: "all",
      files: {
        "/": join(import.meta.dir, "..", "ui"),
        "/tree/": tree,
        // 网页用的 Markdown 渲染（内网里不一定连得上 CDN）
        "/vendor/marked/": join(import.meta.dir, "..", "..", "..", "node_modules", "marked", "lib"),
      },
      expose: ["tree_list", "tree_create", "chat_read", "chat_post"],
    },
  },
});
