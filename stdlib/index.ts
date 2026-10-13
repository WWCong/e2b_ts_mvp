/**
 * stdlib：harness 的框架包，唯一的公开入口。
 * - 写插件：op / decorator / plugin 声明，Ctx、Result 等类型
 * - 搭应用：Kernel、loadPlugin；自带的插件在 stdlib/plugins 下，按路径装载，如 loadPlugin(kernel, "stdlib/plugins/time")
 * kernel 下的其他模块（日志、回放等）是内部实现，不从这里导出。
 */

export { decorator, op, plugin, type PluginObject } from "./kernel/plugin";
export { Kernel, type KernelConfig } from "./kernel/kernel";
export { loadPlugin } from "./kernel/loader";
export type { Packages } from "./kernel/ops";
export type { Ctx, Rejected, Result, ToolSpec } from "./kernel/run";
export type { HarnessEvent } from "./kernel/events";
