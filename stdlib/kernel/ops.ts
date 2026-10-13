/**
 * 调别的 Operation 的类型：注册表 Packages 由应用的装配侧补全（包名 → 插件声明的类型，import type 即可），
 * ctx.ops 与 ctx.call 据它推出入参与结果的类型。只在编译期；运行时照常经内核按名字调用，
 * 目标在不在、在不在能力面、入参对不对仍由内核检查。
 */

import type { z } from "zod";
import type { OpDecl, PluginDecl } from "./plugin";
import type { Result } from "./run";

/**
 * 装配了哪些包：应用在自己的装配类型文件里补全，如
 *   declare module "stdlib" { interface Packages { fs: typeof fs } }
 */
export interface Packages {}

type Pkg = keyof Packages & string;
type OperationsOf<D> = D extends PluginDecl<any, infer P> ? (P extends { operations: infer M } ? M : {}) : {};
/** 调用方要填的入参：带默认值的字段可不填 */
type InputOf<D> = D extends { input: z.ZodType<any, infer I> } ? I : never;
type OutputOf<D> = D extends { impl: (...args: any[]) => Promise<infer O> } ? O : never;

/** 名字 → 注册表里它的声明，不在的为 never。只查名字里的那个包：查全表会把调用方自己的包也卷进来，类型绕成环 */
type DeclOf<N> = N extends `${infer P}_${infer K}`
  ? P extends Pkg
    ? K extends keyof OperationsOf<Packages[P]>
      ? OperationsOf<Packages[P]>[K]
      : never
    : never
  : never;

/**
 * ctx.call：名字在注册表里时，入参按它检查、结果带它的类型；
 * 不在的（名字是变量，如模型挑的工具；或测试里临时注册的）入参与结果都是 unknown，不报错。
 * 写死的调用用 ctx.ops：名字能补全，拼错编译即报错。
 */
export type Call = <N extends string>(
  name: N,
  input: [DeclOf<N>] extends [never] ? unknown : InputOf<DeclOf<N>>,
) => Promise<Result<[DeclOf<N>] extends [never] ? unknown : OutputOf<DeclOf<N>>>>;

/** ctx.ops：ctx.ops.fs.read(input) 即 ctx.call("fs_read", input)，包与 Operation 都须在注册表里 */
export type Ops = {
  readonly [P in Pkg]: {
    readonly [K in keyof OperationsOf<Packages[P]>]: (
      input: InputOf<OperationsOf<Packages[P]>[K]>,
    ) => Promise<Result<OutputOf<OperationsOf<Packages[P]>[K]>>>;
  };
};

/** 由内核的按名字调用生成 ctx.call 与 ctx.ops */
export function calls(call: (name: string, input: unknown) => Promise<Result>): { call: Call; ops: Ops } {
  // 不认 then：免得 await ctx.ops.fs 之类把它当成 thenable
  const member = <T>(key: string | symbol, make: (key: string) => T) =>
    typeof key === "string" && key !== "then" ? make(key) : undefined;
  const ops = new Proxy(
    {},
    {
      get: (_, pkg) =>
        member(pkg, (pkg) => new Proxy({}, { get: (_, key) => member(key, (key) => (input: unknown) => call(`${pkg}_${key}`, input)) })),
    },
  );
  return { call: call as Call, ops: ops as Ops };
}
