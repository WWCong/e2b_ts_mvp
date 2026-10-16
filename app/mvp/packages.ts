/**
 * 装配类型：这个应用自己的插件里提供 Operation 的包，与 main.ts 装载的一一对应（trace 没有 Operation，不用登记；
 * stdlib 自带的由 stdlib 登记，见 stdlib/plugins/packages.ts）。只用 import type，运行时什么也不加载。
 * 插件里 ctx.ops.fs.read(…) 与 ctx.call("fs_read", …) 的类型由此推出（stdlib/kernel/ops.ts）。
 */

import type agent from "./plugins/agent";
import type chat from "./plugins/chat";
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
