/**
 * 入口：把外面的一种介质（终端、HTTP、gRPC…）接到 Harness 的对外接口上。
 * 入口只在 stdlib 里写：entry() 不从 stdlib 公开导出，app 的插件拿不到对外接口；
 * 插件用 api 声明自己的哪些 Operation 能从外面调，由入口按各自的介质提供出去。
 * 入口也是插件（依赖、挂点照常），工厂多拿一个对外接口，另有服务循环 serve：
 * 宿主在启动完成（树已恢复）后调它，所有入口的 serve 都结束就关停（host.ts）。
 * 启停是宿主的事，入口与插件都碰不到。
 */

import type { Outside } from "./outside";
import type { PluginObject } from "./plugin";

export type { Outside };

/** 入口对象：插件对象加上服务循环。serve 结束表示这个入口不再服务（比如终端的输入结束） */
export type EntryObject = PluginObject & { serve(): Promise<void> };

export type EntryDecl<C> = { kind: "entry"; factory: (config: C, outside: Outside) => EntryObject };

/** 声明入口：factory 以装配配置与对外接口调用一次，返回入口对象 */
export function entry<C = Record<string, never>>(factory: (config: C, outside: Outside) => EntryObject): EntryDecl<C> {
  return { kind: "entry", factory };
}
