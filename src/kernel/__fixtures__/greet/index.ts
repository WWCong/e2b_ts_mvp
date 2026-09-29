/** 测试用插件：打招呼 */

import { z } from "zod";
import { decorator, op } from "../../harness";

export const hello = op({
  input: z.object({ name: z.string().describe("对方的名字") }),
  decorators: ["greet.polite"],
  impl: async (_ctx, input) => `hello ${input.name}`,
});

export const bye = op({
  input: z.object({ name: z.string() }),
  impl: async (_ctx, input) => `bye ${input.name}`,
});

/** 给名字加上敬称；名字为空时出错，由 open 跳过 */
export const polite = decorator({
  onError: "open",
  fn: async (_ctx, run, next) => {
    const { name } = run.input as { name: string };
    if (!name) throw new Error("empty name");
    run.input = { name: `尊敬的${name}` };
    return next();
  },
});
