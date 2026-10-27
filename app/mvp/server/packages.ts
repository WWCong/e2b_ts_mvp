/**
 * 装配类型：这个应用自己的插件与 script 包，与 main.ts 装载的一一对应
 * （stdlib 自带的由 stdlib 登记，见 stdlib/plugins/packages.ts）。只用 import type，运行时什么也不加载。
 * 包里 ctx.ops.fs.read(…) 与 ctx.call("fs_read", …) 的类型由此推出（stdlib/kernel/ops.ts）。
 */

import type agent from "./scripts/agent";
import type chat from "./scripts/chat";
import type fs from "./plugins/fs";
import type model from "./plugins/model";

declare module "stdlib" {
  interface Packages {
    fs: typeof fs;
    model: typeof model;
    agent: typeof agent;
    chat: typeof chat;
  }
}
