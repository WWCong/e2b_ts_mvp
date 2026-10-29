/**
 * stdlib 自带插件的装配类型：登记进 Packages，用 stdlib 的都有这些类型（stdlib/index.ts 引用本文件）。
 * 类型只是契约：装没装由运行时决定，没装的调用照常被拒。应用只登记自己的插件与 script 包（如 app/mvp/server/packages.ts）。
 */

import type fs from "./fs";
import type harness from "./harness";
import type kv from "./kv";
import type model from "./model";
import type pkg from "./package";
import type time from "./time";
import type ui from "./ui";

declare module "stdlib" {
  interface Packages {
    fs: typeof fs;
    harness: typeof harness;
    kv: typeof kv;
    model: typeof model;
    package: typeof pkg;
    time: typeof time;
    ui: typeof ui;
  }
}
