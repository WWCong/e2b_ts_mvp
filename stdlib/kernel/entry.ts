/**
 * 入口：把外面的一种介质（终端、HTTP、gRPC…）接到 Harness 的对外接口上。
 * 入口只在 stdlib 里写：entry() 不从 stdlib 公开导出，app 的插件拿不到对外接口；
 * 插件用 api 声明自己的哪些 Operation 能从外面调，由入口按各自的介质提供出去。
 * 入口也是插件（依赖、挂点照常），工厂多拿一个对外接口，另有服务循环 serve：
 * 宿主在启动完成（树已恢复）后调它，所有入口的 serve 都结束就关停（host.ts）。
 * 启停是宿主的事，入口与插件都碰不到。
 */

import type { PluginObject } from "./plugin";
import type { Result } from "./run";

/** 入口拿到的对外接口（Kernel.outside） */
export type Outside = {
  /** 按名字起一棵 Run 树，返回根的 runId；只能调声明了 api 的 Operation，树的根记下是哪个入口发起的 */
  submit(name: string, input: unknown): string;
  /** 启动时恢复的、由这个入口发起的树的根 runId：上次没做完的，由它收割 */
  recovered(): string[];
  /** 等树结束并取走结果；每棵树只能收一次 */
  reap(runId: string): Promise<Result>;
  /** 把值送给等待中的 park（id 为 park 的 runId），按它的 schema 校验；不在等待或值不符时抛异常 */
  unpark(id: string, value: unknown): void;
  /** 撤回等待中的 park，它以拒绝返回 */
  withdraw(id: string, reason: string): void;
};

/** 入口对象：插件对象加上服务循环。serve 结束表示这个入口不再服务（比如终端的输入结束） */
export type EntryObject = PluginObject & { serve(): Promise<void> };

export type EntryDecl<C> = { kind: "entry"; factory: (config: C, outside: Outside) => EntryObject };

/** 声明入口：factory 以装配配置与对外接口调用一次，返回入口对象 */
export function entry<C = Record<string, never>>(factory: (config: C, outside: Outside) => EntryObject): EntryDecl<C> {
  return { kind: "entry", factory };
}
