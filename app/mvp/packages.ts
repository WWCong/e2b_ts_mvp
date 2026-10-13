/**
 * 装配类型：这个应用装了哪些包，与 main.ts 装载的插件一一对应。只用 import type，运行时什么也不加载。
 * 插件里 ctx.ops.fs.read(…) 与 ctx.call("fs_read", …) 的类型由此推出（stdlib/kernel/ops.ts）。
 */

import type harness from "stdlib/plugins/harness";
import type time from "stdlib/plugins/time";
import type agent from "./plugins/agent";
import type fs from "./plugins/fs";
import type model from "./plugins/model";
import type ui from "./plugins/ui";

declare module "stdlib" {
  interface Packages {
    harness: typeof harness;
    time: typeof time;
    fs: typeof fs;
    model: typeof model;
    ui: typeof ui;
    agent: typeof agent;
  }
}
