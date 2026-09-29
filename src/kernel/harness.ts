/**
 * harness 包：插件用它声明导出的 Operation 与装饰器。
 * 名字由装载器取「包名.导出名」，声明里不写。
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
  /** 自选装饰器，按书写顺序从外到内 */
  decorators?: string[];
  impl: (ctx: Ctx, input: z.output<S>) => Promise<unknown>;
}): OpDecl {
  return { kind: "operation", ...decl };
}

/** 声明一个装饰器；onError 缺省 closed（管控类出错必须中断） */
export function decorator(decl: { onError?: OnError; fn: Decorator }): DecoratorDecl {
  return { kind: "decorator", onError: decl.onError ?? "closed", fn: decl.fn };
}
