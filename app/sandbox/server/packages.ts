/**
 * 装配类型：这个应用自己的插件与 script 包，与 main.ts 装载的一一对应（stdlib 自带的由 stdlib 登记）。
 * 只用 import type，运行时什么也不加载。
 */

import type agent from "./scripts/agent";
import type fs from "./plugins/fs";
import type model from "./plugins/model";
import type manager from "./scripts/manager";

declare module "stdlib" {
  interface Packages {
    agent: typeof agent;
    fs: typeof fs;
    manager: typeof manager;
    model: typeof model;
  }
}
