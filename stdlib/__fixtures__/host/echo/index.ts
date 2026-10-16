/** 测试用插件：echo_say 对外（api）回显 */

import { z } from "zod";
import { op, plugin } from "../../../kernel/plugin";

export default plugin(() => ({
  operations: {
    say: op({ api: true, input: z.object({ text: z.string() }), impl: async (_ctx, { text }) => `echo: ${text}` }),
  },
}));
