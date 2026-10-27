/// <reference path="./plugins/packages.ts" />
/**
 * stdlib：harness 的框架包，唯一的公开入口。
 * - 写包：插件（领域层）用 op / decorator / plugin 声明，script 包（应用层）用 op / script，Ctx、Result 等类型
 * - 搭应用：装配配置交给 host；基建的实现按路径 import（stdlib/infra/volume 的 localDir、stdlib/infra/llm 的 piLlm，
 *   不从这里导出：免得每个插件 import stdlib 都带上模型 SDK）；自带的插件在 stdlib/plugins 下，按路径装载，
 *   如 "stdlib/plugins/time"。Kernel、loadPlugin、loadScript 给测试与自己搭宿主用
 * kernel 下的其他模块（日志、回放等）是内部实现，不从这里导出：对外接口只交给 stdlib 里的服务接口（stdlib/serve），
 * app 的插件用 api 声明自己的哪些 Operation 能对外，装配的 serve.expose 决定实际对外哪些。
 * 客户端（UI、别的系统）不在 stdlib 里：它们在 Harness 外面，归各个应用（如 app/mvp/client），
 * 经服务接口用 Harness；服务接口的协议用到的类型（RunInfo、ParkInfo、ApiInfo、事件、结果）从这里导出。
 */

export { decorator, op, opaque, plugin, script, type OpDecl, type PluginObject, type ScriptObject } from "./kernel/plugin";
export { Kernel, type KernelConfig } from "./kernel/kernel";
export { loadPlugin, loadScript } from "./kernel/loader";
export { host, type Assembly } from "./host";
export type { Infra, Llm, Stat, Volume } from "./infra";
export type { ApiName, Packages } from "./kernel/ops";
export type { Ctx, Rejected, Result, ToolSpec } from "./kernel/run";
export { image, isToolContent, type ContentBlock, type ToolContent } from "./content";
export type { HarnessEvent } from "./kernel/events";
export type { ApiInfo, ParkInfo, RunInfo } from "./kernel/outside";
