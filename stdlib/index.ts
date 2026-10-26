/// <reference path="./plugins/packages.ts" />
/**
 * stdlib：harness 的框架包，唯一的公开入口。
 * - 写插件：op / decorator / plugin 声明，Ctx、Result 等类型
 * - 搭应用：装配配置交给 host；自带的插件在 stdlib/plugins 下、入口在 stdlib/entries 下，按路径装载，
 *   如 "stdlib/plugins/time"。Kernel、loadPlugin 给测试与自己搭宿主用
 * kernel 下的其他模块（日志、回放、入口的声明 entry 等）是内部实现，不从这里导出：
 * 对外接口只交给 stdlib 里的入口，app 的插件用 api 声明自己的哪些 Operation 能从外面调。
 */

export { decorator, op, plugin, type OpDecl, type PluginObject } from "./kernel/plugin";
export { Kernel, type KernelConfig } from "./kernel/kernel";
export { loadPlugin } from "./kernel/loader";
export { host, type Assembly } from "./host";
export type { ApiName, Packages } from "./kernel/ops";
export type { Ctx, Rejected, Result, ToolSpec } from "./kernel/run";
export type { HarnessEvent } from "./kernel/events";
