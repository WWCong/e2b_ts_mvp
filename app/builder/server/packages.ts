/**
 * 装配类型：这个应用自己的插件，与 main.ts 装载的一一对应（stdlib 自带的由 stdlib 登记）。
 * 只用 import type，运行时什么也不加载。
 */

import type chat from "./plugins/chat";
import type tree from "./plugins/tree";

declare module "stdlib" {
  interface Packages {
    chat: typeof chat;
    tree: typeof tree;
  }
}
