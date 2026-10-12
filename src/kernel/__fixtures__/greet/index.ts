/** 测试用插件：打招呼。招呼语取配置，缺省 hello */

import { z } from "zod";
import { decorator, op, plugin } from "../../harness";

export default plugin((config: { greeting?: string }) => {
  const greeting = config.greeting ?? "hello";
  return {
    operations: {
      hello: op({
        input: z.object({ name: z.string().describe("对方的名字") }),
        decorators: ["greet_polite"],
        impl: async (_ctx, input) => `${greeting} ${input.name}`,
      }),
      bye: op({
        input: z.object({ name: z.string() }),
        impl: async (_ctx, input) => `bye ${input.name}`,
      }),
    },
    decorators: {
      /** 给名字加上敬称；名字为空时出错，由 open 跳过 */
      polite: decorator({
        onError: "open",
        fn: async (_ctx, run, next) => {
          const { name } = run.input as { name: string };
          if (!name) throw new Error("empty name");
          run.input = { name: `尊敬的${name}` };
          return next();
        },
      }),
    },
  };
});
