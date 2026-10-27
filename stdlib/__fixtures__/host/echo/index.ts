/** 测试用插件，都对外：echo_say 回显；echo_wait 停在 park 上等一句话；echo_busy 一直在执行 */

import { z } from "zod";
import { op, plugin } from "../../../kernel/plugin";

export default plugin(() => ({
  operations: {
    say: op({
      api: true,
      usage: "回显",
      input: z.object({ text: z.string() }),
      output: z.string(),
      impl: async (_ctx, { text }) => `echo: ${text}`,
    }),
    wait: op({
      api: true,
      usage: "停在 park 上",
      input: z.object({}),
      output: z.unknown(),
      impl: (ctx) => ctx.park({ schema: z.toJSONSchema(z.string()), payload: "等" }),
    }),
    busy: op({ api: true, usage: "一直在执行", input: z.object({}), output: z.unknown(), impl: () => new Promise(() => {}) }),
  },
}));
