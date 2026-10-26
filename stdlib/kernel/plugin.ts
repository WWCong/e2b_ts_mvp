/**
 * 插件的声明（从 stdlib 导出）：插件包的默认导出是 plugin(工厂)：装载时以装配配置调一次工厂，
 * 返回的插件对象里放 Operation、装饰器与挂点方法；工厂里的变量就是这个插件实例自己的状态。
 * Operation 与装饰器的名字取「包名_键名」，声明里不写（kernel.use）。
 */

import type { z } from "zod";
import type { Decorator, DecoratorDef, OnError } from "./chain";
import type { EventBody, HarnessEvent } from "./events";
import type { Operation } from "./kernel";
import type { Ctx } from "./run";

/** I：调用方要填的入参；O：实现返回的值。ctx.ops / ctx.call 据它们推类型（ops.ts） */
export type OpDecl<I = any, O = any> = Omit<Operation, "name" | "input" | "impl"> & {
  input: z.ZodType<unknown, I>;
  impl: (ctx: Ctx, input: any) => Promise<O>;
};
export type DecoratorDecl = Omit<DecoratorDef, "id">;

/**
 * 声明一个 Operation；impl 的 input 类型由 input schema 推出，返回值的类型即调用方拿到的结果。
 * A：是否 api，留在类型里，装配配置的 expose 据它检查（ops.ts 的 ApiName）
 */
export function op<S extends z.ZodType, O, A extends boolean = false>(decl: {
  input: S;
  /** 出参 schema：写了就在返回前按它校验；api 的必须写（对外的契约） */
  output?: z.ZodType<O>;
  /** 用法说明；公开的 Operation 必须写，交给模型时即工具的 description */
  usage?: string;
  /** 公开的才会作为工具交给模型；缺省不公开 */
  public?: boolean;
  /**
   * 能对外：可以列进服务接口的 expose（装配配置）。插件只能声明自己的 Operation；
   * 对不对外由装配决定。api 的必须写 usage 与 output
   */
  api?: A;
  /** 自选装饰器，按书写顺序从外到内 */
  decorators?: string[];
  /** 能力面收窄：项是 Operation 名或包名，先 only 再 exclude；都不写即全开 */
  only?: string[];
  exclude?: string[];
  impl: (ctx: Ctx, input: z.output<S>) => Promise<O>;
}): OpDecl<z.input<S>, O> & { api: NoInfer<A> } {
  // S 的入参类型即 z.input<S>，泛型下 TS 推不出这层关系。
  // A 只从 decl 推：写在插件对象里时，上下文的类型（api?: boolean）会把它放宽成 boolean
  return decl as OpDecl<z.input<S>, O> & { api: A };
}

/** 声明一个装饰器；onError 缺省 closed（管控类出错必须中断） */
export function decorator(decl: { onError?: OnError; fn: Decorator }): DecoratorDecl {
  return { onError: decl.onError ?? "closed", fn: decl.fn };
}

/**
 * 通知类挂点：事件类型 → 接它的方法。事件发生后调，只读；不等它返回，出错只记下，不影响执行。
 * 每种事件恰好对应一个方法，加了事件类型没配方法时类型检查报错。
 */
export const AFTER = {
  "run.started": "afterRunStart",
  "run.exited": "afterRunExit",
  "run.killed": "afterRunKill",
  "run.reaped": "afterRunReap",
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

/** 能拦的挂点返回它表示拦下：veto 是原因，进拒绝结果；by 是拦下的插件的包名 */
export type Veto = { veto: string; retryable?: boolean };

/**
 * 能拦的挂点：方法 → 它拦的转换，即将要发出的事件。转换发生之前同步调，拿到将要发出的事件；
 * 返回 Veto 即拦下，按这个挂点排好的先后问（缺省依赖在前，见 order），第一个拦下的生效，后面的不再问。
 * 必须同步：转换是同步的，等不了；要做 IO 的策略用装饰器。抛异常按拦下处理（管控出错必须中断）。
 * 恢复重放时回送的结果不再过这些挂点，被拦下的结果也照常记进日志、重放时原样回送。
 */
export const BEFORE = {
  /** 一个 Run 将要开始（含恢复时重新执行的）。拦下：子调用以拒绝返回、不建子 Run；外部调用 submit 抛异常 */
  beforeRunStart: "run.started",
  /** 一个 Run 将要退出。拦下：结果换成拒绝 */
  beforeRunExit: "run.exited",
  /** 将要开出 park。拦下：不等待，park 直接以拒绝关闭 */
  beforeParkOpen: "park.opened",
  /** 外部送值或撤回，将要关闭 park（取消引起的不问）。拦下：unpark / withdraw 抛异常，park 照旧等待 */
  beforeParkClose: "park.closed",
  /** 启动时将要恢复一棵树。拦下：这棵树不恢复，以 run.killed 结束，日志移到 diverged/ */
  beforeTreeRecover: "tree.recovered",
} as const satisfies Record<`before${string}`, EventBody["type"]>;

export type BeforeHook = keyof typeof BEFORE;
/** 方法 H 拿到的将要发出的事件（还没有 boot、seq、ts） */
export type BeforeEvent<H extends BeforeHook> = Extract<EventBody, { type: (typeof BEFORE)[H] }>;

/** 事件挂点：能拦的 before*、通知类的 after* 与 afterAny。它们的先后可以按挂点调整（PluginObject.order） */
export const EVENT_HOOKS: readonly string[] = [...Object.keys(BEFORE), ...new Set(Object.values(AFTER)), "afterAny"];
type EventHook = BeforeHook | AfterHook | "afterAny";

/** 插件对象：都可选，没实现的挂点不调 */
export type PluginObject = {
  /**
   * 依赖的插件（包名）。缺了启动失败；插件按依赖排先后（依赖在前，同级按装载顺序）：
   * onStart 依赖先、onStop 依赖后，事件挂点缺省也是依赖先调。引用别的包的装饰器时，那个包必须在这里
   */
  requires?: string[];
  /**
   * 按事件挂点调整先后：before 里的插件在这个挂点上排在自己之后（可以把自己排到依赖前面），after 里的排在自己之前。
   * 没装的插件忽略；排出环来启动失败。onStart、onStop 不能调：依赖必须先启动、后关停
   */
  order?: { [H in EventHook]?: { before?: string[]; after?: string[] } };
  operations?: Record<string, OpDecl>;
  decorators?: Record<string, DecoratorDecl>;
  /** 启动时（kernel.boot），恢复没跑完的树之前调；按依赖的先后逐个 await，抛异常则启动失败 */
  onStart?(): void | Promise<void>;
  /** 启动完成后调（通知）：所有插件都 onStart 过，没跑完的树已恢复 */
  afterStart?(): void | Promise<void>;
  /** 关停时（kernel.stop），在途的树杀掉之后调；按依赖的逆序逐个 await，抛异常只记下、继续关停 */
  onStop?(): void | Promise<void>;
  /** 所有事件（通知），投递、观测类插件用 */
  afterAny?(event: HarnessEvent): void | Promise<void>;
} & { [H in AfterHook]?: (event: EventOf<H>) => void | Promise<void> } & {
  [H in BeforeHook]?: (event: BeforeEvent<H>) => Veto | void;
};

/** 插件对象里认得的键：挂点方法名拼错了不会被调，装载时就报出来 */
export const PLUGIN_KEYS: ReadonlySet<string> = new Set([
  "requires",
  "order",
  "operations",
  "decorators",
  "onStart",
  "afterStart",
  "onStop",
  "afterAny",
  ...Object.values(AFTER),
  ...Object.keys(BEFORE),
]);

/** P：工厂返回的插件对象的具体类型，注册表据它推出各 Operation 的类型 */
export type PluginDecl<C, P extends PluginObject = PluginObject> = { kind: "plugin"; factory: (config: C) => P };

/** 声明插件：factory 以装配配置调用一次，返回插件对象 */
export function plugin<C = Record<string, never>, P extends PluginObject = PluginObject>(
  factory: (config: C) => P,
): PluginDecl<C, P> {
  return { kind: "plugin", factory };
}
