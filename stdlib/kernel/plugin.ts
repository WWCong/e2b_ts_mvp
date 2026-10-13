/**
 * 插件的声明（从 stdlib 导出）：插件包的默认导出是 plugin(工厂)：装载时以装配配置调一次工厂，
 * 返回的插件对象里放 Operation、装饰器与挂点方法；工厂里的变量就是这个插件实例自己的状态。
 * Operation 与装饰器的名字取「包名_键名」，声明里不写（kernel.use）。
 */

import type { z } from "zod";
import type { Decorator, DecoratorDef, OnError } from "./chain";
import type { HarnessEvent } from "./events";
import type { Operation } from "./kernel";
import type { Ctx } from "./run";

export type OpDecl = Omit<Operation, "name">;
export type DecoratorDecl = Omit<DecoratorDef, "id">;

/** 声明一个 Operation；impl 的 input 类型由 input schema 推出 */
export function op<S extends z.ZodType>(decl: {
  input: S;
  /** 用法说明；公开的 Operation 必须写，交给模型时即工具的 description */
  usage?: string;
  /** 公开的才会作为工具交给模型；缺省不公开 */
  public?: boolean;
  /** 自选装饰器，按书写顺序从外到内 */
  decorators?: string[];
  /** 能力面收窄：项是 Operation 名或包名，先 only 再 exclude；都不写即全开 */
  only?: string[];
  exclude?: string[];
  impl: (ctx: Ctx, input: z.output<S>) => Promise<unknown>;
}): OpDecl {
  return decl;
}

/** 声明一个装饰器；onError 缺省 closed（管控类出错必须中断） */
export function decorator(decl: { onError?: OnError; fn: Decorator }): DecoratorDecl {
  return { onError: decl.onError ?? "closed", fn: decl.fn };
}

/**
 * 通知类挂点：事件类型 → 接它的方法。事件发生后调，只读；不等它返回，出错只记下，不影响执行。
 * 每种事件恰好对应一个方法，加了事件类型没配方法时类型检查报错。
 * 后续加入：能拦的 before* 方法。
 */
export const AFTER = {
  "run.started": "afterRunStart",
  "run.exited": "afterRunExit",
  "run.killed": "afterRunKill",
  "call.rejected": "afterCallReject",
  "park.opened": "afterParkOpen",
  "park.closed": "afterParkClose",
  "tree.recovered": "afterTreeRecover",
  "decorator.rewrote": "afterDecorate",
  "decorator.rejected": "afterDecorate",
  "decorator.failed": "afterDecorate",
} as const satisfies Record<HarnessEvent["type"], `after${string}`>;

type AfterHook = (typeof AFTER)[keyof typeof AFTER];
/** 方法 H 接的事件 */
type EventOf<H extends AfterHook> = Extract<
  HarnessEvent,
  { type: { [T in keyof typeof AFTER]: (typeof AFTER)[T] extends H ? T : never }[keyof typeof AFTER] }
>;

/** 插件对象：都可选，没实现的挂点不调 */
export type PluginObject = {
  operations?: Record<string, OpDecl>;
  decorators?: Record<string, DecoratorDecl>;
  /** 启动时（kernel.boot），恢复没跑完的树之前调；按装载顺序逐个 await，抛异常则启动失败 */
  onStart?(): void | Promise<void>;
  /** 启动完成后调（通知）：所有插件都 onStart 过，没跑完的树已恢复 */
  afterStart?(): void | Promise<void>;
  /** 关停时（kernel.stop），在途的树杀掉之后调；按装载的逆序逐个 await，抛异常只记下、继续关停 */
  onStop?(): void | Promise<void>;
  /** 所有事件（通知），投递、观测类插件用 */
  afterAny?(event: HarnessEvent): void | Promise<void>;
} & { [H in AfterHook]?: (event: EventOf<H>) => void | Promise<void> };

/** 插件对象里认得的键：挂点方法名拼错了不会被调，装载时就报出来 */
export const PLUGIN_KEYS: ReadonlySet<string> = new Set([
  "operations",
  "decorators",
  "onStart",
  "afterStart",
  "onStop",
  "afterAny",
  ...Object.values(AFTER),
]);

export type PluginDecl<C> = { kind: "plugin"; factory: (config: C) => PluginObject };

/** 声明插件：factory 以装配配置调用一次，返回插件对象 */
export function plugin<C = Record<string, never>>(factory: (config: C) => PluginObject): PluginDecl<C> {
  return { kind: "plugin", factory };
}
