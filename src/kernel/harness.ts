/**
 * harness 包：插件用它声明导出的 Operation 与装饰器。
 * 名字由装载器取「包名_导出名」，声明里不写。
 */

import type { z } from "zod";
import type { Decorator, DecoratorDef, OnError } from "./chain";
import type { Operation } from "./kernel";
import type { Ctx } from "./run";

export type OpDecl = { kind: "operation" } & Omit<Operation, "name">;
export type DecoratorDecl = { kind: "decorator" } & Omit<DecoratorDef, "id">;

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
  return { kind: "operation", ...decl };
}

/** 声明一个装饰器；onError 缺省 closed（管控类出错必须中断） */
export function decorator(decl: { onError?: OnError; fn: Decorator }): DecoratorDecl {
  return { kind: "decorator", onError: decl.onError ?? "closed", fn: decl.fn };
}
