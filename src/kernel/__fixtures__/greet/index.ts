/** 测试用插件：打招呼 */

import type { Ctx, Result, Run } from "../../run";

/**
 * 向某人打招呼
 * @decorators greet.polite
 */
export async function hello(_ctx: Ctx, input: { name: string }) {
  return `hello ${input.name}`;
}

export async function bye(_ctx: Ctx, input: { name: string }) {
  return `bye ${input.name}`;
}

/**
 * 给名字加上敬称；名字为空时出错，由 open 跳过
 * @decorator
 * @onError open
 */
export async function polite(_ctx: Ctx, run: Run, next: () => Promise<Result>) {
  const { name } = run.input as { name: string };
  if (!name) throw new Error("empty name");
  run.input = { name: `尊敬的${name}` };
  return next();
}
