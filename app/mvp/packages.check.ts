/**
 * 只做类型检查（tsc），不运行：注册表推出的类型符合预期，写错的地方编译即报错。
 * @ts-expect-error 那一行若不再报错，tsc 反过来报错。
 */

import { plugin, type ApiName, type Ctx, type Result } from "stdlib";

export async function check(ctx: Ctx) {
  // 入参按 schema 检查，带默认值的字段可不填；结果带实现返回值的类型
  const read = await ctx.ops.fs.read({ path: "a.md" });
  if (read.ok) read.value satisfies string;
  const list = await ctx.ops.fs.list({});
  if (list.ok) list.value satisfies string;
  const now = await ctx.call("time_now", null);
  if (now.ok) now.value satisfies number;

  // 名字是变量（模型挑的工具）：照常调用，入参与结果是 unknown
  const name: string = "fs_read";
  const any = await ctx.call(name, { whatever: 1 });
  if (any.ok) any.value satisfies unknown;

  // @ts-expect-error 包里没有这个 Operation
  await ctx.ops.fs.delete({ path: "a.md" });
  // @ts-expect-error 没有这个包
  await ctx.ops.web.search({ q: "x" });
  // @ts-expect-error 入参字段写错
  await ctx.ops.fs.read({ file: "a.md" });
  // @ts-expect-error 入参字段写错（ctx.call 的名字在注册表里时同样检查）
  await ctx.call("fs_read", { file: "a.md" });
  // @ts-expect-error 结果类型不符
  if (read.ok) read.value satisfies number;
}

// 装配配置的 expose 只能填声明了 api 的 Operation
export const exposed: ApiName[] = ["chat_say", "chat_reset", "chat_greet"];
// @ts-expect-error chat_load 没声明 api，不能对外
export const internal: ApiName = "chat_load";
// @ts-expect-error 拼错的名字
export const typo: ApiName = "chat_sya";

// plugin() 记下插件对象的具体类型之后，挂点方法的参数照样按事件类型推出
plugin(() => ({ afterRunExit: (e) => void (e.result satisfies Result) }));
// 能拦的挂点：返回 { veto } 即拦下；必须同步，写成 async 编译即报错
plugin(() => ({ beforeRunStart: (e) => (e.depth > 8 ? { veto: "太深了" } : undefined) }));
// @ts-expect-error before* 挂点不能是 async
plugin(() => ({ beforeRunStart: async () => {} }));
